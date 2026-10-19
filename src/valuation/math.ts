/** Small numeric helpers for the valuation module. Pure; every function returns null rather than NaN or Infinity. */
import { diffDays, type ISODate } from '../core/dates';
import { round } from '../core/util';

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Round to 6 decimals and normalise -0, so values compare exactly against thresholds (14.999999999999998 -> 15). */
export function r6(x: number): number {
  const v = round(x, 6);
  return v === 0 ? 0 : v;
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** The last `n` elements (all of them when there are fewer). */
export function lastN<T>(xs: readonly T[], n: number): T[] {
  return xs.slice(Math.max(0, xs.length - n));
}

/** Whole years between two dates, at least 1 (52/53-week fiscal calendars still count as one year per statement). */
export function yearsBetween(from: ISODate, to: ISODate): number {
  return Math.max(1, Math.round(diffDays(to, from) / 365.25));
}

/** Compound annual growth as a fraction; null unless both endpoints are positive and `years` >= 1. */
export function cagr(first: number, last: number, years: number): number | null {
  if (!(first > 0) || !(last > 0) || !(years >= 1)) return null;
  const g = (last / first) ** (1 / years) - 1;
  return Number.isFinite(g) ? g : null;
}

export interface Point {
  periodEnd: ISODate;
  value: number;
}

/** CAGR between the first and last point, as a percentage, with the number of years it spans. */
export function pointsCagr(points: readonly Point[]): { pct: number | null; years: number } {
  if (points.length < 2) return { pct: null, years: 0 };
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  const years = yearsBetween(first.periodEnd, last.periodEnd);
  const g = cagr(first.value, last.value, years);
  return { pct: g === null ? null : g * 100, years };
}

/**
 * Percentile rank of `x` within `sample`, 0 to 100: the share of points below x plus half the share equal to x
 * (the mid-rank convention, so the smallest of four values is the 13th percentile, not the 0th).
 */
export function percentRank(sample: readonly number[], x: number): number {
  if (sample.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const v of sample) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return ((below + equal / 2) / sample.length) * 100;
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st. */
export function ordinal(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  const m10 = n % 10;
  return `${n}${m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th'}`;
}

/** toFixed without the "-0.0" artefact. */
export function fixed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}
export const pctText = (x: number): string => `${fixed(x, 1)}%`;
export const timesText = (x: number): string => `${fixed(x, 2)}x`;
