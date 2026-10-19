/**
 * Hong Kong stock board lots and exchange names from the HKEX "List of Securities" workbook. `Board Lot` is the number
 * of shares per trading lot, NOT the option contract size (data/hk-board-lots.csv): for 9 of the 14 watchlist names the
 * two differ.
 */
import { canonicalSymbol } from '../../core/symbols';
import { ProviderError } from '../yahoo/client';
import { getUniverseBytes } from './http';
import { readXlsx } from './xlsx';

export const HKEX_SECURITIES_URL =
  'https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx';

export interface HkexSecurity {
  /** Canonical four-digit symbol. */
  symbol: string;
  name: string;
  /** Shares per trading lot. */
  lot: number;
  category: string;
}

/** Every row of the workbook that has a five-digit stock code and a whole-number board lot, keyed by canonical symbol. */
export function parseHkexSecurities(buf: Buffer): Map<string, HkexSecurity> {
  const sheet = readXlsx(buf)[0];
  const headerAt = sheet?.rows.findIndex((r) => (r[0] ?? '').trim().toLowerCase() === 'stock code') ?? -1;
  if (!sheet || headerAt < 0) throw new ProviderError('hkex', 'securities', 'no "Stock Code" header row', 'format');
  const header = (sheet.rows[headerAt] as string[]).map((c) => c.trim().toLowerCase());
  const col = (label: string, fallback: number): number => {
    const i = header.findIndex((c) => c.startsWith(label));
    return i >= 0 ? i : fallback;
  };
  const cName = col('name of securities', 1);
  const cCategory = col('category', 2);
  const cLot = col('board lot', 4);
  const out = new Map<string, HkexSecurity>();
  for (const r of sheet.rows.slice(headerAt + 1)) {
    const code = (r[0] ?? '').trim();
    if (!/^\d{5}$/.test(code)) continue;
    const lot = Number((r[cLot] ?? '').replace(/,/g, ''));
    if (!Number.isInteger(lot) || lot <= 0) continue;
    out.set(canonicalSymbol('HK', code), {
      symbol: canonicalSymbol('HK', code),
      name: (r[cName] ?? '').trim(),
      lot,
      category: (r[cCategory] ?? '').trim(),
    });
  }
  if (out.size < 200) throw new ProviderError('hkex', 'securities', `only ${out.size} securities parsed`, 'format');
  return out;
}

export async function fetchHkexSecurities(fetchFn: typeof fetch): Promise<Map<string, HkexSecurity>> {
  return parseHkexSecurities(await getUniverseBytes(fetchFn, 'hkex', 'securities', HKEX_SECURITIES_URL));
}
