import { describe, expect, it } from 'vitest';
import {
  bsGreeks,
  bsPrice,
  expectedPutLossGivenItm,
  expectedPutPayoff,
  impliedVol,
  type OptionRight,
  probItm,
  probTouchApprox,
} from '../../src/indicators';

const RIGHTS: OptionRight[] = ['P', 'C'];

describe('bsPrice: published values', () => {
  it('Hull, Options Futures and Other Derivatives: S=42 K=40 r=10% sigma=20% T=0.5', () => {
    expect(bsPrice('C', 42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(4.7594, 4);
    expect(bsPrice('P', 42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(0.8086, 4);
  });

  it('S=100 K=100 r=5% sigma=20% T=1', () => {
    expect(bsPrice('C', 100, 100, 1, 0.05, 0.2)).toBeCloseTo(10.4506, 4);
    expect(bsPrice('P', 100, 100, 1, 0.05, 0.2)).toBeCloseTo(5.5735, 4);
  });

  it('with a dividend yield (Hull ch. 17: S=930 K=900 r=8% q=3% sigma=20% T=2/12)', () => {
    // Hull's index-option example (Example 17.x): call ~ 51.83 with q = 3%.
    expect(bsPrice('C', 930, 900, 2 / 12, 0.08, 0.2, 0.03)).toBeCloseTo(51.83, 1);
  });

  it('t <= 0 returns intrinsic value', () => {
    expect(bsPrice('P', 90, 100, 0, 0.05, 0.2)).toBe(10);
    expect(bsPrice('P', 110, 100, 0, 0.05, 0.2)).toBe(0);
    expect(bsPrice('C', 110, 100, -1, 0.05, 0.2)).toBe(10);
    expect(bsPrice('C', 90, 100, 0, 0.05, 0.2)).toBe(0);
  });

  it('sigma = 0 gives the discounted forward intrinsic limit', () => {
    const t = 0.5;
    const r = 0.05;
    expect(bsPrice('C', 100, 90, t, r, 0)).toBeCloseTo(100 - 90 * Math.exp(-r * t), 10);
    expect(bsPrice('P', 100, 90, t, r, 0)).toBeCloseTo(0, 10);
  });

  it('rejects invalid inputs', () => {
    expect(() => bsPrice('P', 0, 100, 1, 0.05, 0.2)).toThrow(RangeError);
    expect(() => bsPrice('P', 100, -1, 1, 0.05, 0.2)).toThrow(RangeError);
    expect(() => bsPrice('P', 100, 100, 1, 0.05, -0.2)).toThrow(RangeError);
    expect(() => bsPrice('P', Number.NaN, 100, 1, 0.05, 0.2)).toThrow(RangeError);
    expect(() => bsGreeks('C', 100, 100, 1, 0.05, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('put-call parity: C - P = S e^{-qT} - K e^{-rT}', () => {
  it('holds on a grid including q > 0', () => {
    let n = 0;
    for (const s of [50, 100, 137.5]) {
      for (const k of [40, 100, 160]) {
        for (const t of [0.02, 0.25, 1, 3]) {
          for (const r of [0, 0.03, 0.1]) {
            for (const sigma of [0.05, 0.2, 0.6, 1.5]) {
              for (const q of [0, 0.02, 0.07]) {
                const c = bsPrice('C', s, k, t, r, sigma, q);
                const p = bsPrice('P', s, k, t, r, sigma, q);
                const rhs = s * Math.exp(-q * t) - k * Math.exp(-r * t);
                expect(Math.abs(c - p - rhs)).toBeLessThan(1e-10);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBe(3 * 3 * 4 * 3 * 4 * 3);
  });
});

describe('bsGreeks', () => {
  // Finite-difference checks against bsPrice. Units: delta per $1, gamma per $1^2, vega per +0.01 sigma,
  // theta per calendar day (= -dP/dT / 365), rho per +0.01 rate.
  const cases: { s: number; k: number; t: number; r: number; sigma: number; q: number }[] = [
    { s: 100, k: 100, t: 1, r: 0.05, sigma: 0.2, q: 0 },
    { s: 42, k: 40, t: 0.5, r: 0.1, sigma: 0.2, q: 0 },
    { s: 100, k: 90, t: 0.25, r: 0.03, sigma: 0.35, q: 0.02 },
    { s: 100, k: 115, t: 2, r: 0.0, sigma: 0.5, q: 0.04 },
    { s: 250, k: 200, t: 0.08, r: 0.04, sigma: 0.28, q: 0.01 },
  ];

  for (const right of RIGHTS) {
    it.each(cases)(`${right}: matches finite differences of bsPrice (%o)`, ({ s, k, t, r, sigma, q }) => {
      const g = bsGreeks(right, s, k, t, r, sigma, q);
      const px = (spot: number, tt: number, rr: number, sg: number): number => bsPrice(right, spot, k, tt, rr, sg, q);

      const hs = s * 1e-4;
      const delta = (px(s + hs, t, r, sigma) - px(s - hs, t, r, sigma)) / (2 * hs);
      expect(g.delta).toBeCloseTo(delta, 6);

      const hg = s * 1e-3;
      const gamma = (px(s + hg, t, r, sigma) - 2 * px(s, t, r, sigma) + px(s - hg, t, r, sigma)) / (hg * hg);
      expect(g.gamma).toBeCloseTo(gamma, 5);

      const hv = 1e-5;
      const vega = (px(s, t, r, sigma + hv) - px(s, t, r, sigma - hv)) / (2 * hv) / 100;
      expect(g.vega).toBeCloseTo(vega, 6);

      const ht = 1e-5;
      const thetaPerYear = -(px(s, t + ht, r, sigma) - px(s, t - ht, r, sigma)) / (2 * ht);
      expect(g.theta).toBeCloseTo(thetaPerYear / 365, 6);

      const hr = 1e-6;
      const rho = (px(s, t, r + hr, sigma) - px(s, t, r - hr, sigma)) / (2 * hr) / 100;
      expect(g.rho).toBeCloseTo(rho, 6);
    });
  }

  it('put delta is negative in (-1, 0); call delta in (0, 1); call - put delta = e^{-qT}', () => {
    for (const k of [60, 90, 100, 110, 150]) {
      for (const q of [0, 0.03]) {
        const p = bsGreeks('P', 100, k, 0.5, 0.04, 0.3, q);
        const c = bsGreeks('C', 100, k, 0.5, 0.04, 0.3, q);
        expect(p.delta).toBeLessThanOrEqual(0);
        expect(p.delta).toBeGreaterThanOrEqual(-1);
        expect(c.delta).toBeGreaterThanOrEqual(0);
        expect(c.delta).toBeLessThanOrEqual(1);
        expect(c.delta - p.delta).toBeCloseTo(Math.exp(-q * 0.5), 12);
        expect(c.gamma).toBeCloseTo(p.gamma, 14);
        expect(c.vega).toBeCloseTo(p.vega, 14);
      }
    }
  });

  it('short ATM put: positive theta for the seller (long theta negative), vega positive', () => {
    const g = bsGreeks('P', 100, 100, 30 / 365, 0.04, 0.25);
    expect(g.theta).toBeLessThan(0);
    expect(g.vega).toBeGreaterThan(0);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.rho).toBeLessThan(0);
  });

  it('expired options: intrinsic delta, all other greeks 0', () => {
    expect(bsGreeks('P', 90, 100, 0, 0.05, 0.2)).toEqual({ delta: -1, gamma: 0, theta: 0, vega: 0, rho: 0 });
    expect(bsGreeks('P', 110, 100, 0, 0.05, 0.2)).toEqual({ delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 });
    expect(bsGreeks('C', 110, 100, -0.1, 0.05, 0.2).delta).toBe(1);
    expect(bsGreeks('C', 90, 100, 0, 0.05, 0.2).delta).toBe(0);
  });
});

describe('impliedVol', () => {
  it('round trips price -> iv -> price (< 1e-8) over a grid, puts and calls, q >= 0', () => {
    let tested = 0;
    for (const right of RIGHTS) {
      for (const k of [60, 90, 100, 110, 150]) {
        for (const t of [7 / 365, 0.25, 1, 2.5]) {
          for (const r of [0, 0.03, 0.08]) {
            for (const sigma of [0.05, 0.15, 0.3, 0.6, 1.2, 2.5]) {
              for (const q of [0, 0.02, 0.06]) {
                const price = bsPrice(right, 100, k, t, r, sigma, q);
                const iv = impliedVol(right, price, 100, k, t, r, q);
                if (iv === null) continue; // no time value left / below numerical resolution
                tested++;
                expect(Math.abs(bsPrice(right, 100, k, t, r, iv, q) - price)).toBeLessThan(1e-8);
                // where vega is meaningful the volatility itself must be recovered
                const vegaRaw = bsGreeks(right, 100, k, t, r, sigma, q).vega * 100;
                if (vegaRaw > 1e-3) expect(iv).toBeCloseTo(sigma, 6);
              }
            }
          }
        }
      }
    }
    expect(tested).toBeGreaterThan(1500);
  });

  it('recovers the textbook vol: Hull put 0.8086 at sigma=20%', () => {
    expect(impliedVol('P', bsPrice('P', 42, 40, 0.5, 0.1, 0.2), 42, 40, 0.5, 0.1)).toBeCloseTo(0.2, 10);
    expect(impliedVol('C', 10.4506, 100, 100, 1, 0.05)).toBeCloseTo(0.2, 4);
  });

  it('a typical short-dated OTM put quote', () => {
    const iv = impliedVol('P', 1.35, 100, 95, 30 / 365, 0.045);
    expect(iv).not.toBeNull();
    expect(bsPrice('P', 100, 95, 30 / 365, 0.045, iv!)).toBeCloseTo(1.35, 9);
  });

  it('returns null when t <= 0', () => {
    expect(impliedVol('P', 5, 95, 100, 0, 0.05)).toBeNull();
    expect(impliedVol('C', 5, 105, 100, -0.1, 0.05)).toBeNull();
  });

  it('returns null below intrinsic / discounted intrinsic', () => {
    // put K=100 S=90 r=5% T=1: discounted intrinsic = 100 e^-0.05 - 90 = 5.1229
    expect(impliedVol('P', 5.0, 90, 100, 1, 0.05)).toBeNull();
    expect(impliedVol('P', 5.1229, 90, 100, 1, 0.05)).toBeNull(); // still just below
    expect(impliedVol('P', 5.5, 90, 100, 1, 0.05)).not.toBeNull();
    // call S=110 K=100 r=5% T=1: lower bound = 110 - 100 e^-0.05 = 14.877
    expect(impliedVol('C', 12, 110, 100, 1, 0.05)).toBeNull();
    // with q > 0 the bound is S e^{-qT} - K e^{-rT}
    // 110 e^{-0.1} - 100 e^{-0.05} = 4.4228: price 3 is below it, 9 is fine
    expect(impliedVol('C', 3, 110, 100, 1, 0.05, 0.1)).toBeNull();
    expect(impliedVol('C', 9, 110, 100, 1, 0.05, 0.1)).not.toBeNull();
    // price at (not above) the bound has no time value
    expect(impliedVol('P', 100 * Math.exp(-0.05) - 90, 90, 100, 1, 0.05)).toBeNull();
  });

  it('returns null at or above the upper bound, or for non-positive / non-finite prices', () => {
    expect(impliedVol('P', 100 * Math.exp(-0.05), 90, 100, 1, 0.05)).toBeNull(); // put <= K e^{-rt}
    expect(impliedVol('P', 120, 90, 100, 1, 0.05)).toBeNull();
    expect(impliedVol('C', 100, 100, 100, 1, 0.05)).toBeNull(); // call < S
    expect(impliedVol('P', 0, 90, 100, 1, 0.05)).toBeNull();
    expect(impliedVol('P', -1, 90, 100, 1, 0.05)).toBeNull();
    expect(impliedVol('P', Number.NaN, 90, 100, 1, 0.05)).toBeNull();
    expect(impliedVol('P', 3, 0, 100, 1, 0.05)).toBeNull();
  });

  it('returns null when the implied vol is outside [1e-4, 5.0]', () => {
    expect(impliedVol('C', bsPrice('C', 100, 100, 1, 0.03, 6), 100, 100, 1, 0.03)).toBeNull();
    expect(impliedVol('P', bsPrice('P', 100, 100, 1, 0.03, 4.9), 100, 100, 1, 0.03)).toBeCloseTo(4.9, 6);
    expect(impliedVol('C', bsPrice('C', 100, 100, 1, 0.03, 1e-5), 100, 100, 1, 0.03)).toBeNull();
  });
});

describe('probItm / probTouchApprox', () => {
  it('put ITM probability is N(-d2); call is its complement; they sum to 1', () => {
    for (const k of [80, 100, 120]) {
      const p = probItm('P', 100, k, 0.5, 0.04, 0.3, 0.01);
      const c = probItm('C', 100, k, 0.5, 0.04, 0.3, 0.01);
      expect(p + c).toBeCloseTo(1, 12);
    }
    // d2 for S=K=100, t=1, r=0.05, sigma=0.2: d2 = (0.05 - 0.02)/0.2 = 0.15 -> N(-0.15) = 0.44038
    expect(probItm('P', 100, 100, 1, 0.05, 0.2)).toBeCloseTo(0.440382, 5);
  });

  it('equals -dPrice/dK / e^{-rT} for puts (digital-put identity)', () => {
    const h = 1e-4;
    const args = [100, 0.5, 0.04, 0.3, 0.01] as const;
    const dPdK =
      (bsPrice('P', 100, 100 + h, 0.5, 0.04, 0.3, 0.01) - bsPrice('P', 100, 100 - h, 0.5, 0.04, 0.3, 0.01)) / (2 * h);
    expect(probItm('P', args[0], 100, args[1], args[2], args[3], args[4])).toBeCloseTo(dPdK / Math.exp(-0.04 * 0.5), 6);
  });

  it('decreases as the put strike moves away from spot', () => {
    let prev = 1;
    for (const k of [120, 110, 100, 90, 80, 70, 60]) {
      const p = probItm('P', 100, k, 0.25, 0.03, 0.25);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it('expired: indicator', () => {
    expect(probItm('P', 90, 100, 0, 0.05, 0.2)).toBe(1);
    expect(probItm('P', 110, 100, 0, 0.05, 0.2)).toBe(0);
    expect(probItm('C', 110, 100, 0, 0.05, 0.2)).toBe(1);
  });

  it('probTouchApprox = min(1, 2 * |delta|)', () => {
    expect(probTouchApprox(0.1)).toBeCloseTo(0.2, 12);
    expect(probTouchApprox(0.3)).toBeCloseTo(0.6, 12);
    expect(probTouchApprox(0.5)).toBe(1);
    expect(probTouchApprox(0.8)).toBe(1);
    expect(probTouchApprox(0)).toBe(0);
    expect(probTouchApprox(-0.25)).toBeCloseTo(0.5, 12);
  });
});

describe('expectedPutPayoff / expectedPutLossGivenItm', () => {
  const grid: { s: number; k: number; t: number; r: number; sigma: number; q: number }[] = [];
  for (const k of [70, 90, 100, 120]) {
    for (const t of [0.05, 0.5, 2]) {
      for (const sigma of [0.1, 0.3, 0.8]) {
        for (const q of [0, 0.03]) grid.push({ s: 100, k, t, r: 0.04, sigma, q });
      }
    }
  }

  it.each(grid)('exp(-rt) * E[(K - S_T)^+] equals the Black-Scholes put price (%o)', ({ s, k, t, r, sigma, q }) => {
    const e = expectedPutPayoff(s, k, t, r, sigma, q);
    expect(Math.abs(Math.exp(-r * t) * e - bsPrice('P', s, k, t, r, sigma, q))).toBeLessThan(1e-10);
  });

  it.each(grid)('E[loss | ITM] * P(ITM) = E[(K - S_T)^+] and 0 < loss < K (%o)', ({ s, k, t, r, sigma, q }) => {
    const loss = expectedPutLossGivenItm(s, k, t, r, sigma, q);
    const p = probItm('P', s, k, t, r, sigma, q);
    expect(Math.abs(loss * p - expectedPutPayoff(s, k, t, r, sigma, q))).toBeLessThan(1e-10);
    expect(loss).toBeGreaterThanOrEqual(0);
    expect(loss).toBeLessThan(k);
  });

  it('loss given ITM grows with volatility and time (fatter left tail)', () => {
    const a = expectedPutLossGivenItm(100, 95, 0.25, 0.03, 0.2);
    const b = expectedPutLossGivenItm(100, 95, 0.25, 0.03, 0.4);
    const c = expectedPutLossGivenItm(100, 95, 1, 0.03, 0.4);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('is tiny but finite deep out of the money, 0 on underflow', () => {
    const deep = expectedPutLossGivenItm(100, 50, 0.1, 0.03, 0.2);
    expect(Number.isFinite(deep)).toBe(true);
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(deep).toBeLessThan(1);
    expect(expectedPutLossGivenItm(100, 1, 0.01, 0.03, 0.05)).toBe(0);
  });

  it('expired: intrinsic value', () => {
    expect(expectedPutPayoff(90, 100, 0, 0.05, 0.2)).toBe(10);
    expect(expectedPutLossGivenItm(90, 100, 0, 0.05, 0.2)).toBe(10);
    expect(expectedPutLossGivenItm(110, 100, 0, 0.05, 0.2)).toBe(0);
  });

  it('matches a high-resolution numerical integral of the lognormal payoff', () => {
    const s = 100;
    const k = 105;
    const t = 0.5;
    const r = 0.04;
    const sigma = 0.3;
    const q = 0.01;
    // E[(K - S_T)^+] = integral over z of (K - F exp(-sigma^2 t / 2 + sigma sqrt(t) z))^+ phi(z) dz
    const fwd = s * Math.exp((r - q) * t);
    const phi = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    let integral = 0;
    let probability = 0;
    const dz = 1e-4;
    for (let z = -12; z <= 12; z += dz) {
      const st = fwd * Math.exp(-0.5 * sigma * sigma * t + sigma * Math.sqrt(t) * z);
      if (st < k) {
        integral += (k - st) * phi(z) * dz;
        probability += phi(z) * dz;
      }
    }
    expect(expectedPutPayoff(s, k, t, r, sigma, q)).toBeCloseTo(integral, 5);
    expect(probItm('P', s, k, t, r, sigma, q)).toBeCloseTo(probability, 5);
    expect(expectedPutLossGivenItm(s, k, t, r, sigma, q)).toBeCloseTo(integral / probability, 4);
  });
});
