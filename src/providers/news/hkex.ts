import { addDays, type ISODate } from '../../core/dates';
import { hkDayOf } from '../../core/news';
import { ProviderError } from '../yahoo/client';
import { getText } from './http';
import { decodeEntities, plainText } from './rss';
import type { FetchedNews } from './types';

const BASE = 'https://www1.hkexnews.hk';
export const HKEX_SOURCE = 'HKEXnews';
const LOOKBACK_DAYS = 14;

/** HKEXnews keys its title search on an internal stock id; the lookup answers JSONP: `callback({"stockInfo":[{...}]})`. */
export function hkexPrefixUrl(code5: string): string {
  return `${BASE}/search/prefix.do?&callback=callback&lang=EN&type=A&name=${code5}&market=SEHK`;
}

/** The internal id of a five-digit stock code, from the JSONP prefix lookup; null when HKEXnews does not know it. */
export function parseHkexStockId(body: string, code5: string): number | null {
  const m = /\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/.exec(body.trim());
  if (!m) return null;
  try {
    const j = JSON.parse(m[1] as string) as { stockInfo?: { stockId?: unknown; code?: unknown }[] };
    const hit = (j.stockInfo ?? []).find((s) => String(s.code) === code5);
    return typeof hit?.stockId === 'number' ? hit.stockId : null;
  } catch {
    return null;
  }
}

const yyyymmdd = (d: ISODate): string => d.replace(/-/g, '');

export function hkexSearchUrl(stockId: number, from: ISODate, to: ISODate, rows = 30): string {
  const q = new URLSearchParams({
    sortDir: '0',
    sortByOptions: 'DateTime',
    category: '0',
    market: 'SEHK',
    stockId: String(stockId),
    documentType: '-1',
    fromDate: yyyymmdd(from),
    toDate: yyyymmdd(to),
    title: '',
    searchType: '0',
    t1code: '-2',
    t2Gcode: '-2',
    t2code: '-2',
    rowRange: String(rows),
    lang: 'EN',
  });
  return `${BASE}/search/titleSearchServlet.do?${q.toString()}`;
}

interface RawRow {
  TITLE?: unknown;
  LONG_TEXT?: unknown;
  SHORT_TEXT?: unknown;
  DATE_TIME?: unknown;
  FILE_LINK?: unknown;
}

/** `12/10/2026 17:50` in Hong Kong time. */
export function parseHkexDate(s: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The announcement titles in a title-search response. Rows without a link or a readable date are dropped. */
export function parseHkexAnnouncements(body: string, target: FetchedNews['target']): FetchedNews[] {
  let rows: RawRow[];
  try {
    const outer = JSON.parse(body) as { result?: unknown };
    const inner = typeof outer.result === 'string' ? (JSON.parse(outer.result) as unknown) : outer.result;
    rows = Array.isArray(inner) ? (inner as RawRow[]) : [];
  } catch {
    return [];
  }
  const out: FetchedNews[] = [];
  for (const r of rows) {
    const link = typeof r.FILE_LINK === 'string' ? r.FILE_LINK : '';
    const when = typeof r.DATE_TIME === 'string' ? parseHkexDate(r.DATE_TIME) : null;
    const title = plainText(String(r.TITLE ?? ''));
    if (!link.startsWith('/') || !when || !title) continue;
    // Disclosure returns all share one generic title; the category line says what the filing is.
    const category = plainText(decodeEntities(String(r.LONG_TEXT ?? r.SHORT_TEXT ?? '')));
    out.push({
      source: HKEX_SOURCE,
      url: `${BASE}${link}`,
      title,
      snippet: category && category !== title ? category : null,
      publishedAt: when,
      target,
    });
  }
  return out;
}

/** Stock ids do not change; look each one up once per process. */
const STOCK_IDS = new Map<string, number>();

/** Announcement titles for one HK name (`symbol` is the canonical four-digit code) over the last two weeks. */
export async function fetchHkexAnnouncements(
  fetchFn: typeof fetch,
  symbol: string,
  now: Date,
  ids: Map<string, number> = STOCK_IDS,
): Promise<FetchedNews[]> {
  const code5 = symbol.padStart(5, '0');
  let id = ids.get(code5);
  if (id === undefined) {
    const found = parseHkexStockId(await getText(fetchFn, 'hkex', symbol, hkexPrefixUrl(code5)), code5);
    if (found === null) throw new ProviderError('hkex', symbol, 'HKEXnews has no stock id for this code', 'not_found');
    ids.set(code5, found);
    id = found;
  }
  const to = hkDayOf(now);
  const body = await getText(fetchFn, 'hkex', symbol, hkexSearchUrl(id, addDays(to, -LOOKBACK_DAYS), to));
  return parseHkexAnnouncements(body, { market: 'HK', symbol });
}
