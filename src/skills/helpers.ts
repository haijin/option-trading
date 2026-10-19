import type { Series } from '../indicators/types';

export function lastOf(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/** Value `back` positions before the last element (0 = last), or null when out of range / undefined. */
export function at(series: Series, back: number): number | null {
  const i = series.length - 1 - back;
  if (i < 0) return null;
  const v = series[i];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

export function fmt(x: number | null | undefined, digits = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits);
}

export function pctStr(x: number | null | undefined, digits = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function allFinite(...xs: (number | null | undefined)[]): boolean {
  return xs.every((x) => x !== null && x !== undefined && Number.isFinite(x));
}
