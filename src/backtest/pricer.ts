/**
 * Synthetic option pricer for backtests and daily marks when no real quote exists (docs/05 section 1). Pure.
 *
 *  - `americanPutPrice`: Barone-Adesi-Whaley approximation of an American put (early exercise premium on top of the
 *    European Black-Scholes price). With rate <= 0 an American put is worth its European value, so that is returned.
 *  - `syntheticPut`: sigma is the at-the-money vol; OTM puts get a skew bump (`skewBumpPer10Delta` vol points per 10
 *    delta below ATM, docs/05); the mid is the American price at the bumped sigma.
 *  - `entryCredit` / `exitDebit`: the slippage and model-risk haircuts are subtracted from what is received and added
 *    to what is paid, so synthetic results are never flattering.
 */
import { bsGreeks, bsPrice } from '../indicators/black-scholes';
import { normCdf } from '../indicators/normal';

const DAYS_PER_YEAR = 365;

export interface PutPricingInput {
  spot: number;
  strike: number;
  /** Calendar days to expiry. */
  dte: number;
  rate: number;
  /** Continuous dividend yield (decimal). */
  q?: number;
}

/** Years from calendar days. */
export function yearsFromDays(dte: number): number {
  return dte / DAYS_PER_YEAR;
}

function d1(spot: number, strike: number, t: number, b: number, sigma: number): number {
  return (Math.log(spot / strike) + (b + 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
}

/**
 * Barone-Adesi-Whaley American put. Returns max(european, approximation, intrinsic); never below the European price.
 * The critical price Sc solves K - Sc = P_eu(Sc) - (1 - e^{(b-r)T} N(-d1(Sc))) Sc / q1 and is found by bisection on
 * (0, K): the function is positive near 0 and negative at K, so the bracket is safe.
 */
export function americanPutPrice(i: PutPricingInput, sigma: number): number {
  const q = i.q ?? 0;
  const { spot, strike, rate } = i;
  const t = yearsFromDays(i.dte);
  if (t <= 0) return Math.max(strike - spot, 0);
  const euro = bsPrice('P', spot, strike, t, rate, sigma, q);
  if (rate <= 0 || sigma <= 0) return Math.max(euro, strike - spot, 0);
  const b = rate - q;
  const sig2 = sigma * sigma;
  const nn = (2 * b) / sig2;
  const kk = (2 * rate) / (sig2 * (1 - Math.exp(-rate * t)));
  const q1 = (-(nn - 1) - Math.sqrt((nn - 1) ** 2 + 4 * kk)) / 2;
  const carry = Math.exp((b - rate) * t);
  const g = (s: number): number =>
    strike -
    s -
    bsPrice('P', s, strike, t, rate, sigma, q) +
    ((1 - carry * normCdf(-d1(s, strike, t, b, sigma))) * s) / q1;
  let lo = strike * 1e-6;
  let hi = strike;
  if (!(g(lo) > 0) || !(g(hi) < 0)) return Math.max(euro, strike - spot, 0);
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  const sStar = 0.5 * (lo + hi);
  if (spot <= sStar) return strike - spot;
  const a1 = -(sStar / q1) * (1 - carry * normCdf(-d1(sStar, strike, t, b, sigma)));
  const price = euro + a1 * (spot / sStar) ** q1;
  return Math.max(price, euro, strike - spot, 0);
}

export interface SyntheticPutResult {
  /** Mid price per share (American, at the skew-adjusted sigma). */
  mid: number;
  /** Sigma used after the skew bump. */
  sigma: number;
  /** European put delta (negative) at the skew-adjusted sigma. */
  delta: number;
}

/**
 * Model price of a put. `skewBumpPer10Delta` is a decimal vol amount (0.02 = 2 vol points per 10 delta below the
 * at-the-money delta of 0.5). ATM and ITM puts get no bump.
 */
export function syntheticPut(i: PutPricingInput, sigmaAtm: number, skewBumpPer10Delta: number): SyntheticPutResult {
  const q = i.q ?? 0;
  const t = yearsFromDays(i.dte);
  if (t <= 0) return { mid: Math.max(i.strike - i.spot, 0), sigma: sigmaAtm, delta: i.spot < i.strike ? -1 : 0 };
  const atmDelta = Math.abs(bsGreeks('P', i.spot, i.strike, t, i.rate, sigmaAtm, q).delta);
  const bump = Math.max(0, ((0.5 - atmDelta) / 0.1) * skewBumpPer10Delta);
  const sigma = sigmaAtm + bump;
  return {
    mid: americanPutPrice(i, sigma),
    sigma,
    delta: bsGreeks('P', i.spot, i.strike, t, i.rate, sigma, q).delta,
  };
}

export interface Haircuts {
  /** Share of the premium given away to the spread (0.10 US, 0.15 HK by default). */
  slippage: number;
  /** Extra share for model risk (0.05). */
  modelRisk: number;
}

/** Credit received for selling: the mid, reduced by both haircuts. */
export function entryCredit(mid: number, h: Haircuts): number {
  return Math.max(0, mid * (1 - h.slippage) * (1 - h.modelRisk));
}

/** Debit paid to buy back: the mid, raised by the slippage haircut (model risk applies only to what is received). */
export function exitDebit(mid: number, h: Haircuts): number {
  return mid * (1 + h.slippage);
}

/**
 * Strike (rounded to `tick`) whose put delta is closest to -`deltaTarget` at the skew-adjusted sigma, searched
 * downward from the spot. Used by the naive benchmark and the event studies.
 */
export function strikeForDelta(
  spot: number,
  dte: number,
  rate: number,
  sigmaAtm: number,
  deltaTarget: number,
  skewBumpPer10Delta: number,
  tick: number,
  q = 0,
): number {
  let lo = spot * 0.3;
  let hi = spot * 1.05;
  const abs = (k: number): number =>
    Math.abs(syntheticPut({ spot, strike: k, dte, rate, q }, sigmaAtm, skewBumpPer10Delta).delta);
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (abs(mid) > deltaTarget) hi = mid;
    else lo = mid;
  }
  const raw = 0.5 * (lo + hi);
  return Math.max(tick, Math.round(raw / tick) * tick);
}
