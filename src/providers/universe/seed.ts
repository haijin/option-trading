/**
 * The seed CSVs (data/universe-us.csv, data/universe-hk.csv): the fallback when a live source changes shape, and the
 * way a fresh database gets a universe without any network. One row per (index, name):
 *
 *   index_code,symbol,name,sector,yahoo,stock_lot
 *
 * `yahoo` is only filled where the provider symbol is not the standard spelling (class shares: BRK-B); `stock_lot` is the
 * HK stock board lot (not the option contract size) and empty for US rows or where it was not found. Lines starting
 * with `#` are comments. Regenerate with `pnpm tsx scripts/gen-universe-seed.ts`.
 */
import { canonicalSymbol } from '../../core/symbols';
import { INDEX_MARKET, type IndexCode, isIndexCode, type UniverseMember } from '../../db/universe';

export const SEED_FILES = { US: 'universe-us.csv', HK: 'universe-hk.csv' } as const;
export const SEED_HEADER = 'index_code,symbol,name,sector,yahoo,stock_lot';

/** One CSV record per call: handles quoted fields with commas and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const csvField = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Rows with an unknown index code or an invalid symbol are skipped (the seed is hand-editable). */
export function parseUniverseSeed(text: string): UniverseMember[] {
  const out: UniverseMember[] = [];
  const seen = new Set<string>();
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^index_code\s*,/i.test(line)) continue;
    const [code, sym, name, sector, yahoo, lot] = splitCsvLine(line);
    const indexCode = (code ?? '').toUpperCase();
    if (!isIndexCode(indexCode) || !sym) continue;
    const market = INDEX_MARKET[indexCode];
    let symbol: string;
    try {
      symbol = canonicalSymbol(market, sym);
    } catch {
      continue;
    }
    const key = `${indexCode}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stockLot = Number(lot);
    out.push({
      market,
      symbol,
      name: name || symbol,
      sector: sector ? sector : null,
      indexCode,
      ...(yahoo ? { yahoo } : {}),
      ...(market === 'HK' && Number.isInteger(stockLot) && stockLot > 0 ? { stockLot } : {}),
    });
  }
  return out;
}

const INDEX_ORDER: IndexCode[] = ['SPX', 'NDX', 'MID', 'HSI', 'HSCEI', 'HSTECH', 'HSCI'];

/** CSV text for one market's members: grouped by index in a fixed order, symbols sorted, with a comment header. */
export function formatUniverseSeed(members: readonly UniverseMember[], comment: string): string {
  const rows = [...members].sort(
    (a, b) => INDEX_ORDER.indexOf(a.indexCode) - INDEX_ORDER.indexOf(b.indexCode) || a.symbol.localeCompare(b.symbol),
  );
  const lines = comment.split('\n').map((l) => `# ${l}`);
  lines.push(SEED_HEADER);
  for (const m of rows)
    lines.push(
      [m.indexCode, m.symbol, m.name, m.sector ?? '', m.yahoo ?? '', m.stockLot ? String(m.stockLot) : '']
        .map(csvField)
        .join(','),
    );
  return `${lines.join('\n')}\n`;
}
