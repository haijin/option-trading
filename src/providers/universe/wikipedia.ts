/**
 * US constituents from the Wikipedia list pages (S&P 500, Nasdaq-100, S&P MidCap 400), read as wikitext through the
 * MediaWiki `action=parse` API: a few dozen KB per page instead of the rendered HTML (the S&P 400 page is ~2 MB), and
 * the table is plain markup that a small parser reads. The parser looks for the table whose header has a symbol/ticker
 * column and reads the name and sector columns by header text, not by position, so a reordered table still parses.
 */
import { canonicalSymbol, yahooSymbol } from '../../core/symbols';
import type { IndexCode, UniverseMember } from '../../db/universe';
import { ProviderError } from '../yahoo/client';
import { getUniverseText } from './http';

export type WikiIndexCode = 'SPX' | 'NDX' | 'MID';

/** Pages tried in order; the first that yields a constituent table wins. */
export const WIKI_PAGES: Record<WikiIndexCode, string[]> = {
  SPX: ['List_of_S&P_500_companies'],
  NDX: ['List_of_NASDAQ-100_companies', 'Nasdaq-100'],
  MID: ['List_of_S&P_400_companies'],
};

/** Plausible constituent counts; outside the range the list is treated as a parse failure, not an index change. */
export const WIKI_COUNT_RANGE: Record<WikiIndexCode, [number, number]> = {
  SPX: [480, 520],
  NDX: [90, 110],
  MID: [380, 420],
};

export function wikiApiUrl(page: string): string {
  return `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2&redirects=1`;
}

// ------------------------------------------------------------------ wikitext tables
export interface WikiRow {
  header: boolean;
  cells: string[];
}

export interface WikiTable {
  attrs: string;
  rows: WikiRow[];
}

/** Splits `text` on `sep` outside [[links]] and {{templates}}. */
function splitTop(text: string, seps: readonly string[]): string[] {
  const parts: string[] = [];
  let depthLink = 0;
  let depthTpl = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '[[') {
      depthLink++;
      i++;
    } else if (two === ']]') {
      depthLink = Math.max(0, depthLink - 1);
      i++;
    } else if (two === '{{') {
      depthTpl++;
      i++;
    } else if (two === '}}') {
      depthTpl = Math.max(0, depthTpl - 1);
      i++;
    } else if (depthLink === 0 && depthTpl === 0) {
      const sep = seps.find((x) => text.startsWith(x, i));
      if (sep) {
        parts.push(text.slice(start, i));
        start = i + sep.length;
        i += sep.length - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Drops the `attributes |` prefix of a cell (a lone pipe outside links and templates). */
function stripCellAttrs(cell: string): string {
  let depthLink = 0;
  let depthTpl = 0;
  for (let i = 0; i < cell.length; i++) {
    const two = cell.slice(i, i + 2);
    if (two === '[[') {
      depthLink++;
      i++;
    } else if (two === ']]') {
      depthLink = Math.max(0, depthLink - 1);
      i++;
    } else if (two === '{{') {
      depthTpl++;
      i++;
    } else if (two === '}}') {
      depthTpl = Math.max(0, depthTpl - 1);
      i++;
    } else if (cell[i] === '|' && depthLink === 0 && depthTpl === 0) return cell.slice(i + 1);
  }
  return cell;
}

/** Top-level `{| ... |}` tables of a wikitext document (nested tables stay inside their cell as raw text). */
export function parseWikiTables(wikitext: string): WikiTable[] {
  const tables: WikiTable[] = [];
  let cur: WikiTable | null = null;
  let row: WikiRow | null = null;
  let depth = 0;
  const pushRow = (): void => {
    if (cur && row && row.cells.length > 0) cur.rows.push(row);
    row = null;
  };
  for (const raw of wikitext.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('{|')) {
      depth++;
      if (depth === 1) {
        cur = { attrs: line.slice(2).trim(), rows: [] };
        row = null;
        continue;
      }
    }
    if (!cur) continue;
    if (depth > 1) {
      if (line.startsWith('|}')) depth--;
      const last = row?.cells.length ? row.cells.length - 1 : -1;
      if (row && last >= 0) row.cells[last] += `\n${line}`;
      continue;
    }
    if (line.startsWith('|}')) {
      pushRow();
      tables.push(cur);
      cur = null;
      depth = 0;
    } else if (line.startsWith('|-')) {
      pushRow();
    } else if (line.startsWith('|+')) {
      // caption
    } else if (line.startsWith('!') || line.startsWith('|')) {
      const header = line.startsWith('!');
      if (!row) row = { header, cells: [] };
      const pieces = splitTop(line.slice(1), header ? ['||', '!!'] : ['||']);
      for (const p of pieces) row.cells.push(stripCellAttrs(p).trim());
    } else if (row && row.cells.length > 0) {
      row.cells[row.cells.length - 1] += `\n${line}`;
    }
  }
  return tables;
}

const TICKER_TEMPLATES = /^(nyse|nasdaq|nysearca|amex|cboe|bats|bzx|otc)/i;
const PASS_TEMPLATES = /^(nowrap|nobr|small|sort|sortname)$/i;

function templateText(body: string): string {
  const parts = splitTop(body, ['|']).map((p) => p.trim());
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).filter((p) => !/^[A-Za-z0-9_ -]+=/.test(p));
  if (TICKER_TEMPLATES.test(name) || PASS_TEMPLATES.test(name) || name.endsWith('symbol')) return args[0] ?? '';
  return '';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Wikitext cell to plain text: refs, comments, templates (ticker templates keep their symbol), links and markup removed. */
export function wikiPlain(raw: string): string {
  let s = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>\n]+>/g, '');
  for (let i = 0; i < 6 && s.includes('{{'); i++)
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => templateText(body));
  s = s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, g: string) => {
      if (g.startsWith('#')) return String.fromCodePoint(Number(g.slice(1)));
      return ENTITIES[g.toLowerCase()] ?? m;
    });
  return s.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------------- constituents
export interface WikiConstituent {
  symbol: string;
  name: string;
  sector: string | null;
}

/** The Nasdaq-100 page classifies by ICB industry; map it to the GICS-style names the S&P pages use. */
const ICB_TO_SECTOR: Record<string, string> = {
  technology: 'Information Technology',
  telecommunications: 'Communication Services',
  'basic materials': 'Materials',
  'consumer discretionary': 'Consumer Discretionary',
  'consumer staples': 'Consumer Staples',
  'health care': 'Health Care',
  industrials: 'Industrials',
  energy: 'Energy',
  utilities: 'Utilities',
  financials: 'Financials',
  'real estate': 'Real Estate',
};

/** The first table that has a symbol/ticker column, with the constituents it lists (de-duplicated, canonical symbols). */
export function parseConstituentTable(wikitext: string): WikiConstituent[] {
  for (const table of parseWikiTables(wikitext)) {
    const head = table.rows.find((r) => r.header);
    if (!head) continue;
    const labels = head.cells.map((c) => wikiPlain(c).toLowerCase());
    const symCol = labels.findIndex((l) => /^(ticker|symbol)\b|\b(ticker|symbol)$/.test(l));
    if (symCol < 0) continue;
    const nameCol = labels.findIndex((l, i) => i !== symCol && /^(security|company|name)\b/.test(l));
    let secCol = labels.findIndex((l) => /gics.*sector|^sector\b/.test(l));
    if (secCol < 0) secCol = labels.findIndex((l) => /\bindustry\b/.test(l) && !/sub/.test(l));
    const icb = secCol >= 0 && /icb/.test(labels[secCol] ?? '');
    const seen = new Set<string>();
    const out: WikiConstituent[] = [];
    for (const row of table.rows) {
      if (row.header) continue;
      const rawSymbol = wikiPlain(row.cells[symCol] ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9]{0,5}([.-][A-Z0-9]{1,2})?$/.test(rawSymbol)) continue;
      const symbol = canonicalSymbol('US', rawSymbol);
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      const name = nameCol >= 0 ? wikiPlain(row.cells[nameCol] ?? '') : '';
      const sectorText = secCol >= 0 ? wikiPlain(row.cells[secCol] ?? '') : '';
      const sector = sectorText ? (icb ? (ICB_TO_SECTOR[sectorText.toLowerCase()] ?? sectorText) : sectorText) : null;
      out.push({ symbol, name: name || symbol, sector });
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** Class shares carry the provider spelling ('BRK-B') so the seed CSV and the instrument show it. */
export function toUniverseMembers(indexCode: IndexCode, rows: WikiConstituent[]): UniverseMember[] {
  return rows.map((r) => ({
    market: 'US' as const,
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    indexCode,
    ...(r.symbol.includes('.') ? { yahoo: yahooSymbol('US', r.symbol) } : {}),
  }));
}

/** Parses the MediaWiki API response of one page into constituents (throws on an API error or an empty table). */
export function parseWikiApiResponse(body: string, page: string): WikiConstituent[] {
  let json: { parse?: { wikitext?: string }; error?: { code?: string; info?: string } };
  try {
    json = JSON.parse(body);
  } catch {
    throw new ProviderError('wikipedia', page, 'response is not JSON');
  }
  if (json.error) throw new ProviderError('wikipedia', page, json.error.code ?? json.error.info ?? 'API error');
  const text = json.parse?.wikitext;
  if (typeof text !== 'string') throw new ProviderError('wikipedia', page, 'response has no wikitext');
  const rows = parseConstituentTable(text);
  if (rows.length === 0) throw new ProviderError('wikipedia', page, 'no constituent table found', 'format');
  return rows;
}

export interface IndexFetch {
  members: UniverseMember[];
  /** Where the list came from (page title or endpoint). */
  via: string;
  warnings: string[];
}

export async function fetchWikipediaIndex(fetchFn: typeof fetch, indexCode: WikiIndexCode): Promise<IndexFetch> {
  const errors: string[] = [];
  const [lo, hi] = WIKI_COUNT_RANGE[indexCode];
  for (const page of WIKI_PAGES[indexCode]) {
    try {
      const rows = parseWikiApiResponse(
        await getUniverseText(fetchFn, 'wikipedia', page, wikiApiUrl(page), 'application/json'),
        page,
      );
      if (rows.length < lo || rows.length > hi) {
        errors.push(`${page}: ${rows.length} names, expected ${lo}-${hi}`);
        continue;
      }
      return { members: toUniverseMembers(indexCode, rows), via: `wikipedia:${page}`, warnings: [] };
    } catch (err) {
      if ((err as Error).name === 'ReplayMissError') throw err;
      errors.push((err as Error).message);
    }
  }
  throw new ProviderError('wikipedia', indexCode, errors.join('; '), 'format');
}
