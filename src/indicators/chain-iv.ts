/**
 * Volatility summaries from one option-chain snapshot (puts only: this tool sells puts). Pure functions.
 * Quote IVs from free sources are unreliable (Yahoo reports ~0 for stale rows), so an IV is used only when plausible,
 * otherwise it is implied from the bid/ask mid with Black-Scholes.
 */
import { diffDays } from '../core/dates';
import type { OptionChainSnapshot, OptionQuote } from '../core/types';
import { bsGreeks, impliedVol } from './black-scholes';

export const IV_MIN = 0.01;
export const IV_MAX = 5;

export interface StripPoint {
  strike: number;
  iv: number;
  /** true when the IV was implied from the mid because the quote's own IV was missing or implausible. */
  implied: boolean;
  /** Black-Scholes put delta from `iv` (negative). */
  delta: number;
}

export interface ExpiryStrip {
  expiry: string;
  dte: number;
  t: number;
  points: StripPoint[];
}

export function yearsTo(snapshotDate: string, expiry: string): number {
  return diffDays(expiry, snapshotDate) / 365;
}

/** IV of one put quote: the quote's own when plausible, else implied from a sane mid, else null. */
export function quoteIv(
  q: OptionQuote,
  spot: number,
  t: number,
  rate: number,
): { iv: number; implied: boolean } | null {
  if (q.iv !== null && q.iv >= IV_MIN && q.iv <= IV_MAX) return { iv: q.iv, implied: false };
  if (q.bid !== null && q.ask !== null && q.bid > 0 && q.ask >= q.bid) {
    const iv = impliedVol('P', (q.bid + q.ask) / 2, spot, q.strike, t, rate);
    if (iv !== null && iv >= IV_MIN && iv <= IV_MAX) return { iv, implied: true };
  }
  return null;
}

export function expiryStrips(snap: OptionChainSnapshot, rate: number, minDte = 1): ExpiryStrip[] {
  const byExpiry = new Map<string, OptionQuote[]>();
  for (const q of snap.quotes) {
    if (q.right !== 'P') continue;
    const list = byExpiry.get(q.expiry) ?? [];
    list.push(q);
    byExpiry.set(q.expiry, list);
  }
  const strips: ExpiryStrip[] = [];
  for (const [expiry, quotes] of byExpiry) {
    const dte = diffDays(expiry, snap.snapshotDate);
    if (dte < minDte) continue;
    const t = dte / 365;
    const points: StripPoint[] = [];
    for (const q of quotes) {
      const r = quoteIv(q, snap.underlyingPrice, t, rate);
      if (!r) continue;
      const delta = bsGreeks('P', snap.underlyingPrice, q.strike, t, rate, r.iv).delta;
      points.push({ strike: q.strike, iv: r.iv, implied: r.implied, delta });
    }
    points.sort((a, b) => a.strike - b.strike);
    if (points.length > 0) strips.push({ expiry, dte, t, points });
  }
  return strips.sort((a, b) => a.dte - b.dte);
}

/** IV at the money (strike = spot): linear interpolation between the strikes bracketing spot, else the nearest strike within 5%. */
export function atmIv(points: StripPoint[], spot: number): number | null {
  if (points.length === 0) return null;
  let below: StripPoint | null = null;
  let above: StripPoint | null = null;
  for (const p of points) {
    if (p.strike <= spot) below = p;
    else if (above === null) above = p;
  }
  if (below && above) {
    const w = (spot - below.strike) / (above.strike - below.strike);
    return below.iv + w * (above.iv - below.iv);
  }
  const nearest = below ?? above;
  if (nearest && Math.abs(nearest.strike / spot - 1) <= 0.05) return nearest.iv;
  return null;
}

export interface Iv30Result {
  iv30: number;
  iv60: number | null;
  /** IV(front) / IV(next expiry): above ~1.05 is backwardation (usually an event). */
  termRatio: number | null;
  frontDte: number;
  /** true when 30 days lies outside the listed expiries and the nearest one was used. */
  extrapolated: boolean;
  usedImpliedFromMid: boolean;
}

function interpolateTenor(
  strips: { t: number; iv: number }[],
  tenorDays: number,
): { iv: number; extrapolated: boolean } | null {
  if (strips.length === 0) return null;
  const target = tenorDays / 365;
  let lo: { t: number; iv: number } | null = null;
  let hi: { t: number; iv: number } | null = null;
  for (const s of strips) {
    if (s.t <= target) lo = s;
    else if (hi === null) hi = s;
  }
  if (lo && hi) {
    // Linear in total variance (sigma^2 * t) between the bracketing expiries.
    const w1 = lo.iv * lo.iv * lo.t;
    const w2 = hi.iv * hi.iv * hi.t;
    const w = w1 + ((w2 - w1) * (target - lo.t)) / (hi.t - lo.t);
    return { iv: Math.sqrt(Math.max(w, 0) / target), extrapolated: false };
  }
  const nearest = lo ?? hi;
  // Within 10 days of the target tenor the nearest expiry is a fair stand-in; beyond that it is an extrapolation.
  return nearest ? { iv: nearest.iv, extrapolated: Math.abs(nearest.t * 365 - tenorDays) > 10 } : null;
}

export function iv30(snap: OptionChainSnapshot, rate: number): Iv30Result | null {
  const strips = expiryStrips(snap, rate, 7);
  const atm = strips
    .map((s) => ({ s, iv: atmIv(s.points, snap.underlyingPrice) }))
    .filter((x): x is { s: ExpiryStrip; iv: number } => x.iv !== null);
  if (atm.length === 0) return null;
  const series = atm.map((x) => ({ t: x.s.t, iv: x.iv }));
  const r30 = interpolateTenor(series, 30);
  if (!r30) return null;
  const r60 = atm.length > 1 ? interpolateTenor(series, 60) : null;
  const front = atm.find((x) => x.s.dte <= 30) ?? atm[0];
  const idx = front ? atm.indexOf(front) : -1;
  const next = atm[idx + 1];
  return {
    iv30: r30.iv,
    iv60: r60 && !r60.extrapolated ? r60.iv : null,
    termRatio: front && next ? front.iv / next.iv : null,
    frontDte: front ? front.s.dte : 0,
    extrapolated: r30.extrapolated,
    usedImpliedFromMid: atm.some((x) => x.s.points.some((p) => p.implied)),
  };
}

/** 25-delta put IV minus ATM IV on the expiry nearest to `targetDte` (>= 14 days). Positive = rich put skew. */
export function skew25d(snap: OptionChainSnapshot, rate: number, targetDte = 30): number | null {
  const strips = expiryStrips(snap, rate, 14);
  if (strips.length === 0) return null;
  const strip = strips.reduce((best, s) => (Math.abs(s.dte - targetDte) < Math.abs(best.dte - targetDte) ? s : best));
  const atm = atmIv(strip.points, snap.underlyingPrice);
  if (atm === null) return null;
  // put delta falls from ~0 (low strikes) toward -1 (high strikes): find the strike pair bracketing -0.25
  const pts = strip.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as StripPoint;
    const b = pts[i + 1] as StripPoint;
    if (a.delta >= -0.25 && b.delta <= -0.25) {
      const w = (-0.25 - a.delta) / (b.delta - a.delta);
      return a.iv + w * (b.iv - a.iv) - atm;
    }
  }
  return null;
}
