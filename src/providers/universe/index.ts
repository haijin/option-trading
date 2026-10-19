/**
 * Constituent lists for the Leaders universe (docs/designs/leaders-pullback.md, "Universe and data").
 *
 *   US  SPX, NDX, MID   Wikipedia list pages (wikitext through the MediaWiki API)
 *   HK  HSI, HSCEI, HSTECH   hsi.com.hk constituent JSON
 *   HK  HSCI            hsi.com.hk public change log replayed, plus the three lists above (partial; see hsi.ts)
 *   HK  stock lots/names   HKEX List of Securities workbook
 *
 * Every network function takes an injected `fetch`. A source that fails or looks wrong (count out of range, no table)
 * is reported in `sources` and contributes no members; the others still return.
 */

import type { Market } from '../../core/calendar';
import type { ISODate } from '../../core/dates';
import type { IndexCode, UniverseMember } from '../../db/universe';
import { fetchHkexSecurities, type HkexSecurity } from './hkex';
import { fetchHsci, fetchHsiIndex, type HsiIndexCode } from './hsi';
import { fetchWikipediaIndex, type WikiIndexCode } from './wikipedia';

export type { IndexCode, UniverseMember } from '../../db/universe';
export { INDEX_CODES, INDEX_MARKET } from '../../db/universe';
export { parseUniverseSeed, SEED_FILES } from './seed';

export interface UniverseSource {
  indexCode: IndexCode;
  ok: boolean;
  /** Where the list came from (a page title or an endpoint); empty when the fetch failed. */
  via: string;
  count: number;
  warnings: string[];
  error?: string;
}

export interface UniverseFetch {
  /** One row per (index, name), US and HK. */
  members: UniverseMember[];
  sources: UniverseSource[];
  /** HK stock board lots: how many members got one and how many are assumed (not found). */
  lots: { ok: boolean; found: number; assumed: number; error?: string };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function attempt(
  indexCode: IndexCode,
  fn: () => Promise<{ members: UniverseMember[]; via: string; warnings: string[] }>,
  out: { members: UniverseMember[]; sources: UniverseSource[] },
): Promise<void> {
  try {
    const r = await fn();
    out.members.push(...r.members);
    out.sources.push({ indexCode, ok: true, via: r.via, count: r.members.length, warnings: r.warnings });
  } catch (err) {
    if ((err as Error).name === 'ReplayMissError') throw err;
    out.sources.push({ indexCode, ok: false, via: '', count: 0, warnings: [], error: errorText(err) });
  }
}

async function fetchUs(fetchFn: typeof fetch): Promise<{ members: UniverseMember[]; sources: UniverseSource[] }> {
  const out = { members: [] as UniverseMember[], sources: [] as UniverseSource[] };
  for (const code of ['SPX', 'NDX', 'MID'] as WikiIndexCode[])
    await attempt(code, () => fetchWikipediaIndex(fetchFn, code), out);
  return out;
}

async function fetchHk(
  fetchFn: typeof fetch,
  asOf: ISODate,
): Promise<{ members: UniverseMember[]; sources: UniverseSource[]; lots: UniverseFetch['lots'] }> {
  const out = { members: [] as UniverseMember[], sources: [] as UniverseSource[] };
  for (const code of ['HSI', 'HSCEI', 'HSTECH'] as HsiIndexCode[])
    await attempt(code, () => fetchHsiIndex(fetchFn, code), out);
  const known = new Map<string, string>();
  for (const m of out.members) known.set(m.symbol, m.name);
  await attempt('HSCI', () => fetchHsci(fetchFn, { asOf, known }), out);

  let securities: Map<string, HkexSecurity> | null = null;
  let lotsError: string | undefined;
  try {
    securities = await fetchHkexSecurities(fetchFn);
  } catch (err) {
    if ((err as Error).name === 'ReplayMissError') throw err;
    lotsError = errorText(err);
  }
  let found = 0;
  const symbols = new Set<string>();
  const members = out.members.map((m) => {
    symbols.add(m.symbol);
    const sec = securities?.get(m.symbol);
    return sec ? { ...m, name: sec.name || m.name, stockLot: sec.lot } : m;
  });
  for (const s of symbols) if (securities?.has(s)) found++;
  return {
    members,
    sources: out.sources,
    lots: { ok: securities !== null, found, assumed: symbols.size - found, ...(lotsError ? { error: lotsError } : {}) },
  };
}

/**
 * Fetches the lists of the requested markets (default both). `asOf` is the date the Composite change log is replayed to
 * (changes announced for a later effective date are ignored).
 */
export async function fetchUniverse(
  fetchFn: typeof fetch,
  opts: { asOf: ISODate; markets?: readonly Market[] },
): Promise<UniverseFetch> {
  const markets = opts.markets ?? ['US', 'HK'];
  const [us, hk] = await Promise.all([
    markets.includes('US') ? fetchUs(fetchFn) : null,
    markets.includes('HK') ? fetchHk(fetchFn, opts.asOf) : null,
  ]);
  return {
    members: [...(us?.members ?? []), ...(hk?.members ?? [])],
    sources: [...(us?.sources ?? []), ...(hk?.sources ?? [])],
    lots: hk?.lots ?? { ok: true, found: 0, assumed: 0 },
  };
}
