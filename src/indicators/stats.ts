/**
 * Small descriptive-statistics helpers. Pure functions; inputs are never mutated.
 * Undefined results (empty input, too few observations) are returned as NaN so the return type stays `number`.
 */

/** Arithmetic mean. NaN for an empty array. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Median (average of the two middle values for even lengths). NaN for an empty array. */
export function median(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Sample variance (divisor n - 1), two-pass. NaN for fewer than 2 observations. */
export function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return ss / (n - 1);
}

/** Sample standard deviation (divisor n - 1). NaN for fewer than 2 observations. */
export function stdev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/** Population standard deviation (divisor n), as used by Bollinger Bands / TA-Lib BBANDS. NaN for an empty array. */
export function populationStdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / n);
}
