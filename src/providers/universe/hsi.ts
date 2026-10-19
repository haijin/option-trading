/**
 * Hong Kong constituents from the Hang Seng Indexes site (hsi.com.hk). The site is a JS app; these are the endpoints
 * it calls itself:
 *
 * - `constituent/metadata/v2?data=rt&seriesCode=hsi|hscei|hstech`: the live constituent list of the three indexes the
 *   site shows without a logon (stock code and an abbreviated name per member).
 * - `content/gcs/download?resource=.../hisConstituent/hsci/hist_hsci.xlsx`: the public change log of the Hang Seng
 *   Composite Index. The composite's own list is behind a logon (the API answers `viewConsDetail: null`), so it is
 *   rebuilt by replaying the log. The log starts at the 2008-09-08 review and lists changes only, so the members that
 *   have never changed since then are missing from the replay; the HSI / HSCEI / HSTECH members (all inside the
 *   composite) fill part of that gap, and the rest is reported as a warning with the exact numbers.
 */
import type { ISODate } from '../../core/dates';
import { canonicalSymbol } from '../../core/symbols';
import type { UniverseMember } from '../../db/universe';
import { ProviderError } from '../yahoo/client';
import { getUniverseBytes, getUniverseText } from './http';
import { readXlsx, type XlsxSheet } from './xlsx';

export type HsiIndexCode = 'HSI' | 'HSCEI' | 'HSTECH';

const HSI_API = 'https://www.hsi.com.hk/api/wsit-hsi-ddoc-ea-public-website-proxy/v1';

export const HSI_SERIES: Record<HsiIndexCode, string> = { HSI: 'hsi', HSCEI: 'hscei', HSTECH: 'hstech' };

/** Plausible counts; outside the range the list is treated as a parse failure, not an index change. */
export const HSI_COUNT_RANGE: Record<HsiIndexCode | 'HSCI', [number, number]> = {
  HSI: [60, 130],
  HSCEI: [40, 70],
  HSTECH: [25, 45],
  HSCI: [400, 700],
};

export const hsiConstituentsUrl = (series: string): string =>
  `${HSI_API}/product-data/pub/constituent/metadata/v2?data=rt&seriesCode=${series}&language=en-hk`;

export const HSCI_HISTORY_URL = `${HSI_API}/content/gcs/download?resource=/public-website/webapp/contents/en/indexes/hisConstituent/hsci/hist_hsci.xlsx`;

export interface HkConstituent {
  /** Canonical four-digit symbol. */
  symbol: string;
  name: string;
}

/** Members of one index from the `constituent/metadata/v2` response (sub-index lists are flattened and de-duplicated). */
export function parseHsiConstituents(
  body: string,
  indexCode: string,
): { rows: HkConstituent[]; declared: number | null } {
  let json: {
    data?: {
      numOfConsList?: { count?: number }[];
      viewConsDetail?: Record<
        string,
        { stockCode?: string; stockName?: string; isDummy?: string; stockType?: string }[]
      > | null;
    };
  };
  try {
    json = JSON.parse(body);
  } catch {
    throw new ProviderError('hsi', indexCode, 'response is not JSON');
  }
  const detail = json.data?.viewConsDetail;
  if (!detail || typeof detail !== 'object')
    throw new ProviderError(
      'hsi',
      indexCode,
      'response has no constituent list (the series may need a logon)',
      'format',
    );
  const seen = new Set<string>();
  const rows: HkConstituent[] = [];
  for (const list of Object.values(detail)) {
    for (const x of list ?? []) {
      if (x.isDummy === 'Y' || (x.stockType && x.stockType !== 'HK')) continue;
      let symbol: string;
      try {
        symbol = canonicalSymbol('HK', String(x.stockCode ?? ''));
      } catch {
        continue;
      }
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      rows.push({ symbol, name: (x.stockName ?? '').trim() || symbol });
    }
  }
  const declared = json.data?.numOfConsList?.[0]?.count;
  return { rows, declared: typeof declared === 'number' ? declared : null };
}

const asMembers = (indexCode: HsiIndexCode | 'HSCI', rows: HkConstituent[]): UniverseMember[] =>
  rows.map((r) => ({ market: 'HK' as const, symbol: r.symbol, name: r.name, sector: null, indexCode }));

export async function fetchHsiIndex(
  fetchFn: typeof fetch,
  indexCode: HsiIndexCode,
): Promise<{ members: UniverseMember[]; via: string; warnings: string[] }> {
  const series = HSI_SERIES[indexCode];
  const { rows, declared } = parseHsiConstituents(
    await getUniverseText(fetchFn, 'hsi', indexCode, hsiConstituentsUrl(series)),
    indexCode,
  );
  const [lo, hi] = HSI_COUNT_RANGE[indexCode];
  if (rows.length < lo || rows.length > hi)
    throw new ProviderError('hsi', indexCode, `${rows.length} names, expected ${lo}-${hi}`, 'format');
  const warnings: string[] = [];
  if (declared !== null && declared !== rows.length)
    warnings.push(`${indexCode}: the list has ${rows.length} names but the site declares ${declared}`);
  return { members: asMembers(indexCode, rows), via: `hsi.com.hk:${series}`, warnings };
}

// ----------------------------------------------------------------------- composite
export interface HsciReplay {
  /** Constituents the change log leaves in the index at `asOf`: symbol to the log's English name. */
  members: Map<string, string>;
  /** "No. of Constituents (After Change)" the log declares for the last change on or before `asOf`. */
  declared: number | null;
  /** Effective date of that last change. */
  lastChange: ISODate | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Replays the composite's change log up to `asOf`: the last event for a stock code decides whether it is in. Within one
 * effective date deletions are applied before additions (a reused stock code is deleted, then added).
 */
export function replayHsciChanges(sheets: XlsxSheet[], asOf: ISODate): HsciReplay {
  const sheet = sheets.find((s) => s.name.trim().toUpperCase() === 'HSCI') ?? sheets[0];
  if (!sheet) throw new ProviderError('hsi', 'HSCI', 'the change log has no sheets', 'format');
  const headerAt = sheet.rows.findIndex((r) => r.some((c) => /effective date/i.test(c)));
  const header = headerAt >= 0 ? (sheet.rows[headerAt] as string[]) : [];
  const col = (re: RegExp, fallback: number): number => {
    const i = header.findIndex((c) => re.test(c));
    return i >= 0 ? i : fallback;
  };
  const cDate = col(/effective date/i, 0);
  const cAfter = col(/no\. of constituents/i, 1);
  const cChange = col(/^change\b/i, 2);
  const cCode = col(/stock code/i, 4);
  const cName = col(/stock name/i, 6);

  interface Ev {
    day: ISODate;
    code: string;
    add: boolean;
    name: string;
    after: number | null;
  }
  const events: Ev[] = [];
  for (const r of sheet.rows.slice(headerAt + 1)) {
    const day = (r[cDate] ?? '').trim();
    if (!ISO_DAY.test(day) || day > asOf) continue;
    const kind = (r[cChange] ?? '').trim().toLowerCase();
    if (!kind.startsWith('add') && !kind.startsWith('delete')) continue;
    let code: string;
    try {
      code = canonicalSymbol('HK', String(Number.parseInt(r[cCode] ?? '', 10)));
    } catch {
      continue;
    }
    const after = Number.parseFloat(r[cAfter] ?? '');
    events.push({
      day,
      code,
      add: kind.startsWith('add'),
      name: (r[cName] ?? '').trim(),
      after: Number.isFinite(after) ? after : null,
    });
  }
  if (events.length === 0) throw new ProviderError('hsi', 'HSCI', 'the change log has no usable rows', 'format');
  events.sort((a, b) => a.day.localeCompare(b.day) || Number(a.add) - Number(b.add));
  const members = new Map<string, string>();
  for (const e of events) {
    if (e.add) members.set(e.code, e.name || e.code);
    else members.delete(e.code);
  }
  const last = events[events.length - 1] as Ev;
  const declared = events.filter((e) => e.day === last.day && e.after !== null).map((e) => e.after)[0] ?? null;
  return { members, declared, lastChange: last.day };
}

/**
 * The composite as far as it can be known without a logon: the replayed log plus every member of `known` (the HSI,
 * HSCEI and HSTECH lists, which are subsets of the composite).
 */
export async function fetchHsci(
  fetchFn: typeof fetch,
  opts: { asOf: ISODate; known: ReadonlyMap<string, string> },
): Promise<{ members: UniverseMember[]; via: string; warnings: string[] }> {
  const sheets = readXlsx(await getUniverseBytes(fetchFn, 'hsi', 'HSCI', HSCI_HISTORY_URL));
  const replay = replayHsciChanges(sheets, opts.asOf);
  const union = new Map(replay.members);
  let fromKnown = 0;
  for (const [code, name] of opts.known)
    if (!union.has(code)) {
      union.set(code, name);
      fromKnown++;
    }
  const [lo, hi] = HSI_COUNT_RANGE.HSCI;
  if (union.size < lo || union.size > hi)
    throw new ProviderError('hsi', 'HSCI', `${union.size} names after the replay, expected ${lo}-${hi}`, 'format');
  const warnings: string[] = [];
  if (replay.declared !== null && union.size !== replay.declared) {
    const gap = replay.declared - union.size;
    warnings.push(
      gap > 0
        ? `HSCI: ${union.size} of the ${replay.declared} constituents are known (the public change log starts at the 2008 review and the full list needs a Hang Seng logon; ${replay.members.size} from the log, ${fromKnown} more from HSI/HSCEI/HSTECH); ${gap} unchanged-since-2008 members are missing`
        : `HSCI: ${union.size} names but the log declares ${replay.declared}`,
    );
  }
  return {
    members: asMembers(
      'HSCI',
      [...union].map(([symbol, name]) => ({ symbol, name })),
    ),
    via: `hsi.com.hk:hist_hsci (replay to ${replay.lastChange ?? 'n/a'})`,
    warnings,
  };
}
