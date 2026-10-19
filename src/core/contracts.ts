import type { ISODate } from './dates';
import type { Market, OptionRight } from './types';

export type DeltaBucket = '0-10' | '10-20' | '20-30' | '30+';
export const DELTA_BUCKETS: readonly DeltaBucket[] = ['0-10', '10-20', '20-30', '30+'];

/** Bucket on |delta| (put delta is negative; the sign is ignored). */
export function deltaBucket(delta: number): DeltaBucket {
  const d = Math.abs(delta);
  if (d < 0.1) return '0-10';
  if (d < 0.2) return '10-20';
  if (d < 0.3) return '20-30';
  return '30+';
}

export function contractKey(right: OptionRight, strike: number, expiry: ISODate): string {
  return `${right}|${strike}|${expiry}`;
}

/** Listed-strike increment used when building a synthetic strike grid. */
export function strikeIncrement(market: Market, price: number): number {
  if (market === 'US') {
    if (price < 25) return 0.5;
    if (price < 200) return 1;
    return 5;
  }
  if (price < 5) return 0.05;
  if (price < 10) return 0.1;
  if (price < 20) return 0.2;
  if (price < 50) return 0.5;
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  if (price < 500) return 5;
  if (price < 1000) return 10;
  return 20;
}

/** Smallest price tick used for the "mid minus one tick" fill assumption. */
export function priceTick(market: Market, price: number): number {
  if (market === 'US') return 0.01;
  if (price < 0.25) return 0.001;
  if (price < 0.5) return 0.005;
  if (price < 10) return 0.01;
  return 0.05;
}

/** Annual risk-free rate by market. */
export function riskFreeFor(market: Market, usRate: number, hkRate: number): number {
  return market === 'HK' ? hkRate : usRate;
}

export const YEAR_DAYS = 365;
