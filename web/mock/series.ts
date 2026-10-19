import type { Profile } from './model';
import { avg, hash, mulberry, round } from './util';

export const SERIES_LENGTH = 380;
const cache = new Map<string, number[]>();

/**
 * 380 deterministic pseudo-random closes ending exactly at `spot`: a drifting line from `pathA x spot`, AR(1) noise, and a
 * dip down to the support level about 50 sessions ago (the price never closes below support in the last 90 sessions).
 */
export function priceSeries(p: Profile): number[] {
  const key = `${p.symbol}|${p.spot}|${p.tech.support}|${p.pathA}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const n = SERIES_LENGTH;
  const dipAt = 330;
  const rnd = mulberry(hash(p.symbol));
  const base = (t: number) => p.spot * (p.pathA + ((1 - p.pathA) * t) / (n - 1));
  const depth = Math.max(0.012, base(dipAt) / p.spot - p.tech.support / p.spot);
  let x = 0;
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    x = 0.8 * x + (rnd() - 0.5) * 0.012;
    let v = base(t) * (1 + x) - p.spot * depth * Math.exp(-(((t - dipAt) / 10) ** 2));
    if (t >= n - 90) v = Math.max(v, p.tech.support * 1.004);
    out.push(v);
  }
  out[dipAt] = p.tech.support;
  out[n - 1] = p.spot;
  const rounded = out.map((v) => round(v, 2));
  cache.set(key, rounded);
  return rounded;
}

/** Simple moving average ending at index `i`, or null while fewer than `k` bars exist. */
export function smaAt(s: number[], i: number, k: number): number | null {
  return i < k - 1 ? null : round(avg(s.slice(i - k + 1, i + 1)), 2);
}

export const lastSma = (s: number[], k: number): number => avg(s.slice(-k));
