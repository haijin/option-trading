/**
 * Black-Scholes-Merton for European options on an asset paying a continuous dividend yield q.
 * All functions are pure. Conventions used throughout:
 *   spot, strike  in price units (> 0)
 *   t             time to expiry in YEARS (the caller chooses the day-count; t <= 0 means "expired")
 *   rate          continuously-compounded risk-free rate, decimal (0.05 = 5 %)
 *   sigma         annualised volatility, decimal (0.20 = 20 %)
 *   q             continuous dividend yield, decimal, default 0
 *
 * Invalid inputs (non-finite numbers, spot <= 0, strike <= 0, sigma < 0) throw a RangeError: they are programmer
 * or data-pipeline errors, not market conditions. sigma = 0 is allowed (it is clamped to a tiny positive value,
 * which gives the discounted-forward-intrinsic limit).
 */
import { normCdf, normPdf } from './normal';

export type OptionRight = 'P' | 'C';

const MIN_SIGMA = 1e-12;
const DAYS_PER_YEAR = 365;

function validate(spot: number, strike: number, t: number, rate: number, sigma: number, q: number): void {
  if (![spot, strike, t, rate, sigma, q].every(Number.isFinite)) {
    throw new RangeError('Black-Scholes inputs must be finite numbers');
  }
  if (spot <= 0) throw new RangeError(`spot must be > 0, got ${spot}`);
  if (strike <= 0) throw new RangeError(`strike must be > 0, got ${strike}`);
  if (sigma < 0) throw new RangeError(`sigma must be >= 0, got ${sigma}`);
}

function intrinsic(right: OptionRight, spot: number, strike: number): number {
  return right === 'P' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
}

interface D12 {
  d1: number;
  d2: number;
  sqrtT: number;
}

function d1d2(spot: number, strike: number, t: number, rate: number, sigma: number, q: number): D12 {
  const sig = Math.max(sigma, MIN_SIGMA);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate - q + 0.5 * sig * sig) * t) / (sig * sqrtT);
  return { d1, d2: d1 - sig * sqrtT, sqrtT };
}

/** European option price. t <= 0 returns the intrinsic value. */
export function bsPrice(
  right: OptionRight,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  sigma: number,
  q = 0,
): number {
  validate(spot, strike, t, rate, sigma, q);
  if (t <= 0) return intrinsic(right, spot, strike);
  const { d1, d2 } = d1d2(spot, strike, t, rate, sigma, q);
  const dfQ = Math.exp(-q * t);
  const dfR = Math.exp(-rate * t);
  return right === 'C'
    ? spot * dfQ * normCdf(d1) - strike * dfR * normCdf(d2)
    : strike * dfR * normCdf(-d2) - spot * dfQ * normCdf(-d1);
}

export interface Greeks {
  /** dPrice/dSpot. Calls 0..1, puts -1..0. */
  delta: number;
  /** d2Price/dSpot2 (per 1.00 price unit of spot, same for calls and puts). */
  gamma: number;
  /** Price change per CALENDAR day (negative for long options): -dPrice/dT / 365. */
  theta: number;
  /** Price change for +1 vol point, i.e. per +0.01 of sigma (= dPrice/dSigma / 100). */
  vega: number;
  /** Price change for +1 percentage point of the risk-free rate, i.e. per +0.01 of rate (= dPrice/dRate / 100). */
  rho: number;
}

/**
 * Black-Scholes Greeks. Units: see {@link Greeks}. The put delta is negative (-1..0).
 * t <= 0 (expired): delta is the intrinsic indicator (call: 1 if spot > strike, put: -1 if spot < strike, else 0)
 * and gamma, theta, vega, rho are 0.
 */
export function bsGreeks(
  right: OptionRight,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  sigma: number,
  q = 0,
): Greeks {
  validate(spot, strike, t, rate, sigma, q);
  if (t <= 0) {
    const delta = right === 'C' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
    return { delta, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sig = Math.max(sigma, MIN_SIGMA);
  const { d1, d2, sqrtT } = d1d2(spot, strike, t, rate, sigma, q);
  const dfQ = Math.exp(-q * t);
  const dfR = Math.exp(-rate * t);
  const pdf1 = normPdf(d1);
  const decay = -(spot * dfQ * pdf1 * sig) / (2 * sqrtT);

  const gamma = (dfQ * pdf1) / (spot * sig * sqrtT);
  const vega = (spot * dfQ * pdf1 * sqrtT) / 100;
  if (right === 'C') {
    return {
      delta: dfQ * normCdf(d1),
      gamma,
      theta: (decay - rate * strike * dfR * normCdf(d2) + q * spot * dfQ * normCdf(d1)) / DAYS_PER_YEAR,
      vega,
      rho: (strike * t * dfR * normCdf(d2)) / 100,
    };
  }
  return {
    delta: -dfQ * normCdf(-d1),
    gamma,
    theta: (decay + rate * strike * dfR * normCdf(-d2) - q * spot * dfQ * normCdf(-d1)) / DAYS_PER_YEAR,
    vega,
    rho: (-strike * t * dfR * normCdf(-d2)) / 100,
  };
}

const IV_MIN = 1e-4;
const IV_MAX = 5.0;

/**
 * Implied volatility of a European option from its price (decimal, e.g. 0.25 = 25 %).
 *
 * Safeguarded Newton-Raphson (Newton steps inside a maintained bisection bracket, "rtsafe") on [1e-4, 5.0], so it
 * always converges. Round trip bsPrice(iv) reproduces `price` to far better than 1e-8 for normal inputs.
 *
 * Returns null when no volatility in [1e-4, 5.0] reproduces the price:
 *  - t <= 0, or a non-finite / non-positive input (spot, strike) or non-finite price;
 *  - the price is at or below the discounted intrinsic value (no time value, vol undefined), or implies vol < 1e-4;
 *  - the price is at or above the no-arbitrage upper bound (spot * e^{-qt} for calls, strike * e^{-rt} for puts),
 *    or implies vol > 5.0.
 * Note this is the EUROPEAN lower bound: an American put quoted below K - S but above the discounted intrinsic
 * value is accepted.
 */
export function impliedVol(
  right: OptionRight,
  price: number,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  q = 0,
): number | null {
  if (![price, spot, strike, t, rate, q].every(Number.isFinite)) return null;
  if (t <= 0 || spot <= 0 || strike <= 0 || price <= 0) return null;

  const dfQ = Math.exp(-q * t);
  const dfR = Math.exp(-rate * t);
  const fwdLower = right === 'C' ? spot * dfQ - strike * dfR : strike * dfR - spot * dfQ;
  const lower = Math.max(fwdLower, 0);
  const upper = right === 'C' ? spot * dfQ : strike * dfR;
  if (price <= lower || price >= upper) return null;

  const f = (sigma: number): number => bsPrice(right, spot, strike, t, rate, sigma, q) - price;
  let lo = IV_MIN;
  let hi = IV_MAX;
  const fLo = f(lo);
  const fHi = f(hi);
  if (fLo > 0 || fHi < 0) return null; // implied vol is outside [IV_MIN, IV_MAX]
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;

  // Initial guess: Brenner-Subrahmanyam ATM approximation, clamped into the bracket.
  let sigma = Math.min(Math.max(Math.sqrt((2 * Math.PI) / t) * (price / spot), 0.05), 3);
  const tol = 1e-14 * Math.max(1, strike);
  for (let iter = 0; iter < 200; iter++) {
    const fv = f(sigma);
    if (Math.abs(fv) <= tol) return sigma;
    if (fv > 0) hi = sigma;
    else lo = sigma;
    const { d1, sqrtT } = d1d2(spot, strike, t, rate, sigma, q);
    const vega = spot * dfQ * normPdf(d1) * sqrtT; // raw dPrice/dSigma
    let next = vega > 1e-300 ? sigma - fv / vega : Number.NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi); // Newton left the bracket: bisect
    if (Math.abs(next - sigma) <= 1e-15 * Math.max(1, sigma) || hi - lo <= 1e-15) return next;
    sigma = next;
  }
  return sigma;
}

/**
 * Risk-neutral probability of finishing in the money: P(S_T < K) = N(-d2) for puts, P(S_T > K) = N(d2) for
 * calls. t <= 0 returns the 0/1 indicator of being in the money now.
 */
export function probItm(
  right: OptionRight,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  sigma: number,
  q = 0,
): number {
  validate(spot, strike, t, rate, sigma, q);
  if (t <= 0) return intrinsic(right, spot, strike) > 0 ? 1 : 0;
  const { d2 } = d1d2(spot, strike, t, rate, sigma, q);
  return right === 'P' ? normCdf(-d2) : normCdf(d2);
}

/**
 * Heuristic probability that the underlying TOUCHES the strike before expiry: min(1, 2 * |delta|). Based on the
 * reflection principle (touch probability ~ twice the finishing probability) with |delta| standing in for
 * P(ITM). It ignores drift and discrete monitoring and is an approximation, not a model output.
 */
export function probTouchApprox(deltaAbs: number): number {
  return Math.min(1, 2 * Math.abs(deltaAbs));
}

/**
 * E[(K - S_T)^+], the UNDISCOUNTED risk-neutral expected payoff of a put, with S_T lognormal and drift r - q:
 *
 *   F  = S * exp((r - q) * t)                       (forward)
 *   E[(K - S_T)^+] = K * N(-d2) - F * N(-d1)
 *
 * Identity: exp(-r t) * E[(K - S_T)^+] = bsPrice('P', ...). For a short put the expected P&L under the
 * risk-neutral measure is credit - exp(-r t) * expectedPutPayoff (zero at fair value). t <= 0 returns the intrinsic value.
 */
export function expectedPutPayoff(spot: number, strike: number, t: number, rate: number, sigma: number, q = 0): number {
  validate(spot, strike, t, rate, sigma, q);
  if (t <= 0) return intrinsic('P', spot, strike);
  const { d1, d2 } = d1d2(spot, strike, t, rate, sigma, q);
  const fwd = spot * Math.exp((rate - q) * t);
  return Math.max(strike * normCdf(-d2) - fwd * normCdf(-d1), 0);
}

/**
 * E[(K - S_T)^+ | S_T < K]: the expected size of the put's payoff (per share, undiscounted, a positive number)
 * given that it finishes in the money, under the risk-neutral measure with drift r - q:
 *
 *   E[(K - S_T)^+ | S_T < K] = E[(K - S_T)^+] / P(S_T < K) = K - F * N(-d1) / N(-d2)
 *
 * with F = S * exp((r - q) t). Returns 0 when P(S_T < K) underflows to 0 (extremely deep OTM) and, for t <= 0,
 * the intrinsic value (0 if out of the money).
 */
export function expectedPutLossGivenItm(
  spot: number,
  strike: number,
  t: number,
  rate: number,
  sigma: number,
  q = 0,
): number {
  validate(spot, strike, t, rate, sigma, q);
  if (t <= 0) return intrinsic('P', spot, strike);
  const { d1, d2 } = d1d2(spot, strike, t, rate, sigma, q);
  const pItm = normCdf(-d2);
  if (pItm <= 0) return 0;
  const fwd = spot * Math.exp((rate - q) * t);
  return Math.max(strike - (fwd * normCdf(-d1)) / pItm, 0);
}
