/**
 * Historical-volatility estimators and rank helpers. Pure functions; outputs of the series estimators are aligned
 * 1:1 with the input and use `null` for warm-up. Volatilities are annualised decimals (0.25 = 25 %).
 */

import type { Ohlc, Series } from './types';

function checkWindow(window: number, min: number): void {
  if (!Number.isInteger(window) || window < min) {
    throw new RangeError(`window must be an integer >= ${min}, got ${window}`);
  }
}

function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** Natural-log returns ln(c[i] / c[i-1]). Index 0 is null, as is any bar with a non-positive price. */
export function logReturns(closes: readonly number[]): Series {
  const out = new Array<number | null>(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    out[i] = a > 0 && b > 0 ? finiteOrNull(Math.log(b / a)) : null;
  }
  return out;
}

/** Sample variance (divisor n-1) of xs[from..to] inclusive, two-pass. */
function sampleVariance(xs: readonly number[], from: number, to: number): number {
  const n = to - from + 1;
  let sum = 0;
  for (let i = from; i <= to; i++) sum += xs[i]!;
  const m = sum / n;
  let ss = 0;
  for (let i = from; i <= to; i++) ss += (xs[i]! - m) * (xs[i]! - m);
  return ss / (n - 1);
}

/**
 * Close-to-close realised volatility: sample standard deviation (n-1) of the last `window` log returns,
 * annualised by sqrt(tradingDays). First value at index `window` (window returns need window + 1 closes).
 * Null where any price in the window is non-positive.
 */
export function realizedVol(closes: readonly number[], window: number, tradingDays = 252): Series {
  checkWindow(window, 2);
  const n = closes.length;
  const out = new Array<number | null>(n).fill(null);
  const rets = new Array<number>(n).fill(Number.NaN);
  for (let i = 1; i < n; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) rets[i] = Math.log(b / a);
  }
  const annual = Math.sqrt(tradingDays);
  for (let i = window; i < n; i++) {
    out[i] = finiteOrNull(Math.sqrt(sampleVariance(rets, i - window + 1, i)) * annual);
  }
  return out;
}

/**
 * Yang & Zhang (2000) drift-independent volatility estimator over a rolling window of n = `window` bars:
 *
 *   o_i  = ln(O_i / C_{i-1})   overnight return          c_i = ln(C_i / O_i)   open-to-close return
 *   rs_i = ln(H/C) ln(H/O) + ln(L/C) ln(L/O)             Rogers-Satchell term
 *   s2_o = sample variance of o (n-1)    s2_c = sample variance of c (n-1)    s2_rs = mean of rs (divisor n)
 *   k    = 0.34 / (1.34 + (n + 1) / (n - 1))
 *   sigma^2 = s2_o + k * s2_c + (1 - k) * s2_rs          vol = sqrt(sigma^2 * tradingDays)
 *
 * First value at index `window` (the first bar of the window needs the previous close). Null where any bar in the
 * window has a non-positive or non-finite price. Requires window >= 2.
 */
export function yangZhangVol(bars: readonly Ohlc[], window: number, tradingDays = 252): Series {
  checkWindow(window, 2);
  const n = bars.length;
  const out = new Array<number | null>(n).fill(null);
  if (n <= window) return out;
  const k = 0.34 / (1.34 + (window + 1) / (window - 1));

  const overnight = new Array<number>(n).fill(Number.NaN);
  const openClose = new Array<number>(n).fill(Number.NaN);
  const rs = new Array<number>(n).fill(Number.NaN);
  for (let i = 1; i < n; i++) {
    const { open, high, low, close } = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    if (!(open > 0 && high > 0 && low > 0 && close > 0 && prevClose > 0)) continue;
    overnight[i] = Math.log(open / prevClose);
    openClose[i] = Math.log(close / open);
    rs[i] = Math.log(high / close) * Math.log(high / open) + Math.log(low / close) * Math.log(low / open);
  }

  for (let i = window; i < n; i++) {
    const from = i - window + 1;
    let rsSum = 0;
    for (let j = from; j <= i; j++) rsSum += rs[j]!;
    const variance =
      sampleVariance(overnight, from, i) + k * sampleVariance(openClose, from, i) + (1 - k) * (rsSum / window);
    out[i] = finiteOrNull(Math.sqrt(variance * tradingDays));
  }
  return out;
}

/**
 * Percentile rank of `value` in `series`: the share (0-100) of observations STRICTLY below `value`.
 * Non-finite entries of `series` are ignored. NaN when there are no usable observations or `value` is NaN.
 * (A value above every observation ranks 100, one at or below the minimum ranks 0.)
 */
export function percentileRank(series: readonly number[], value: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  let total = 0;
  let below = 0;
  for (const x of series) {
    if (!Number.isFinite(x)) continue;
    total++;
    if (x < value) below++;
  }
  return total === 0 ? Number.NaN : (below / total) * 100;
}

/**
 * Position of `value` within the min-max range of `series`: (value - min) / (max - min) * 100, clamped to 0..100.
 * Null when the series has no finite observations, the range is degenerate (max == min), or `value` is NaN.
 */
export function rankInRange(series: readonly number[], value: number): number | null {
  if (Number.isNaN(value)) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of series) {
    if (!Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min === Number.POSITIVE_INFINITY || max === min) return null;
  const r = ((value - min) / (max - min)) * 100;
  return Math.min(100, Math.max(0, r));
}
