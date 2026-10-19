/**
 * Currency conversion through an HKD pivot. Stored pairs (fx_rates, quoted as HKD per 1 unit of the first currency):
 * USDHKD and CNYHKD. HK statements are often reported in a currency other than the trading currency (Tencent in CNY,
 * HSBC in USD), so ratios that mix market cap and statement lines must convert first.
 */
export const FX_PAIRS = ['USDHKD', 'CNYHKD', 'SGDHKD'] as const;
export type FxPair = (typeof FX_PAIRS)[number];

/** Yahoo symbols for the stored pairs. */
export const FX_YAHOO: Record<FxPair, string> = { USDHKD: 'HKD=X', CNYHKD: 'CNYHKD=X', SGDHKD: 'SGDHKD=X' };

/** Rate to convert one unit of `from` into `to`; `lookup(pair)` returns HKD per 1 unit of that currency or null. */
export function fxRate(from: string, to: string, lookup: (pair: FxPair) => number | null): number | null {
  if (from === to) return 1;
  const toHkd = (ccy: string): number | null => {
    if (ccy === 'HKD') return 1;
    const pair = `${ccy}HKD` as FxPair;
    return (FX_PAIRS as readonly string[]).includes(pair) ? lookup(pair) : null;
  };
  const a = toHkd(from);
  const b = toHkd(to);
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return a / b;
}
