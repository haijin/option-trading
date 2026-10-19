import { describe, expect, it } from 'vitest';
import {
  americanPutPrice,
  entryCredit,
  exitDebit,
  strikeForDelta,
  syntheticPut,
  yearsFromDays,
} from '../../src/backtest/pricer';
import { bsPrice } from '../../src/indicators/black-scholes';

/** Cox-Ross-Rubinstein binomial American put, the reference the BAW approximation is checked against. */
function crrAmericanPut(s: number, k: number, t: number, r: number, sigma: number, q: number, steps = 1500): number {
  const dt = t / steps;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const disc = Math.exp(-r * dt);
  const v: number[] = [];
  for (let j = 0; j <= steps; j++) v.push(Math.max(k - s * u ** (steps - j) * d ** j, 0));
  for (let i = steps - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * (v[j] as number) + (1 - p) * (v[j + 1] as number));
      v[j] = Math.max(cont, k - s * u ** (i - j) * d ** j);
    }
  }
  return v[0] as number;
}

describe('americanPutPrice (Barone-Adesi-Whaley)', () => {
  const cases: [string, number, number, number, number, number, number][] = [
    ['ATM 45d', 100, 100, 45, 0.04, 0.25, 0],
    ['OTM 45d', 100, 90, 45, 0.04, 0.3, 0],
    ['ITM 90d high rate', 100, 115, 90, 0.08, 0.3, 0],
    ['deep ITM', 70, 100, 60, 0.05, 0.25, 0.01],
    ['dividend', 100, 105, 120, 0.035, 0.2, 0.03],
  ];
  for (const [name, s, k, dte, r, sigma, q] of cases) {
    it(`tracks the binomial reference: ${name}`, () => {
      const baw = americanPutPrice({ spot: s, strike: k, dte, rate: r, q }, sigma);
      const ref = crrAmericanPut(s, k, yearsFromDays(dte), r, sigma, q);
      expect(Math.abs(baw - ref)).toBeLessThan(Math.max(0.05, ref * 0.02));
    });
  }

  it('is never below the European price or the intrinsic value', () => {
    for (const spot of [60, 80, 95, 100, 120]) {
      const baw = americanPutPrice({ spot, strike: 100, dte: 60, rate: 0.05 }, 0.3);
      expect(baw).toBeGreaterThanOrEqual(bsPrice('P', spot, 100, yearsFromDays(60), 0.05, 0.3) - 1e-9);
      expect(baw).toBeGreaterThanOrEqual(Math.max(100 - spot, 0) - 1e-9);
    }
  });

  it('equals the European price when the rate is not positive', () => {
    const baw = americanPutPrice({ spot: 100, strike: 100, dte: 90, rate: 0 }, 0.3);
    expect(baw).toBeCloseTo(bsPrice('P', 100, 100, yearsFromDays(90), 0, 0.3), 10);
  });

  it('returns intrinsic at or after expiry', () => {
    expect(americanPutPrice({ spot: 90, strike: 100, dte: 0, rate: 0.04 }, 0.3)).toBe(10);
    expect(americanPutPrice({ spot: 110, strike: 100, dte: 0, rate: 0.04 }, 0.3)).toBe(0);
  });
});

describe('syntheticPut', () => {
  it('adds a skew bump to OTM puts only', () => {
    const base = { spot: 100, dte: 45, rate: 0.04 };
    const atm = syntheticPut({ ...base, strike: 100 }, 0.25, 0.02);
    const otm = syntheticPut({ ...base, strike: 85 }, 0.25, 0.02);
    const itm = syntheticPut({ ...base, strike: 110 }, 0.25, 0.02);
    expect(atm.sigma).toBeGreaterThanOrEqual(0.25);
    expect(otm.sigma).toBeGreaterThan(atm.sigma);
    expect(itm.sigma).toBe(0.25);
    expect(otm.delta).toBeLessThan(0);
    expect(otm.delta).toBeGreaterThan(-0.3);
  });

  it('with no bump the mid is at least the European price', () => {
    const r = syntheticPut({ spot: 100, strike: 95, dte: 45, rate: 0.04 }, 0.25, 0);
    expect(r.mid).toBeGreaterThanOrEqual(bsPrice('P', 100, 95, yearsFromDays(45), 0.04, 0.25) - 1e-9);
  });
});

describe('haircuts', () => {
  it('lower what is received and raise what is paid', () => {
    const h = { slippage: 0.1, modelRisk: 0.05 };
    expect(entryCredit(2, h)).toBeCloseTo(2 * 0.9 * 0.95, 12);
    expect(exitDebit(1, h)).toBeCloseTo(1.1, 12);
    expect(entryCredit(0, h)).toBe(0);
  });
});

describe('strikeForDelta', () => {
  it('finds a strike near the requested delta on the tick grid', () => {
    const k = strikeForDelta(100, 45, 0.04, 0.25, 0.3, 0.02, 0.5);
    const d = Math.abs(syntheticPut({ spot: 100, strike: k, dte: 45, rate: 0.04 }, 0.25, 0.02).delta);
    expect(k % 0.5).toBeCloseTo(0, 9);
    expect(Math.abs(d - 0.3)).toBeLessThan(0.03);
    expect(k).toBeLessThan(100);
  });
});
