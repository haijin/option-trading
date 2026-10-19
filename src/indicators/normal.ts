/**
 * Standard normal distribution: density, cumulative distribution and quantile function.
 * Accuracy: normCdf is accurate to ~1e-15 (relative, including the far tails); normInv to ~1e-15.
 */

const SQRT_2PI = 2.5066282746310002;

/** Standard normal probability density function. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Standard normal cumulative distribution function.
 *
 * Hart's (1968) rational Chebyshev approximation in the form published by G. West, "Better approximations to
 * cumulative normal functions" (Wilmott, 2005): double precision (max abs error ~1e-15), and, unlike
 * 1 - Phi(-x) tricks, it keeps full relative accuracy in the lower tail (needed for deep OTM put probabilities).
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const xAbs = Math.abs(x);
  let tail: number; // P(Z > |x|)
  if (xAbs > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * xAbs * xAbs);
    if (xAbs < 7.07106781186547) {
      let num = 3.52624965998911e-2 * xAbs + 0.700383064443688;
      num = num * xAbs + 6.37396220353165;
      num = num * xAbs + 33.912866078383;
      num = num * xAbs + 112.079291497871;
      num = num * xAbs + 221.213596169931;
      num = num * xAbs + 220.206867912376;
      let den = 8.83883476483184e-2 * xAbs + 1.75566716318264;
      den = den * xAbs + 16.064177579207;
      den = den * xAbs + 86.7807322029461;
      den = den * xAbs + 296.564248779674;
      den = den * xAbs + 637.333633378831;
      den = den * xAbs + 793.826512519948;
      den = den * xAbs + 440.413735824752;
      tail = (e * num) / den;
    } else {
      let b = xAbs + 0.65;
      b = xAbs + 4 / b;
      b = xAbs + 3 / b;
      b = xAbs + 2 / b;
      b = xAbs + 1 / b;
      tail = e / b / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

// Acklam's rational approximation coefficients (relative error < 1.15e-9 before refinement).
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
  2.506628277459239,
];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
  2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/**
 * Inverse standard normal CDF (quantile function). Returns -Infinity for p = 0, +Infinity for p = 1 and NaN for
 * p outside [0, 1].
 *
 * Acklam's algorithm (rel. error 1.15e-9) followed by one Halley refinement step using the accurate normCdf,
 * which brings the result to ~1e-15 (comparable to Wichura's AS241).
 */
export function normInv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;

  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }

  // Halley refinement. Work in the lower tail where normCdf keeps relative accuracy.
  const lowerTail = x <= 0;
  const target = lowerTail ? p : 1 - p;
  const z = lowerTail ? x : -x;
  const err = normCdf(z) - target;
  if (Number.isFinite(err)) {
    const u = err * SQRT_2PI * Math.exp(0.5 * z * z);
    const refined = z - u / (1 + 0.5 * z * u);
    if (Number.isFinite(refined)) return lowerTail ? refined : -refined;
  }
  return x;
}
