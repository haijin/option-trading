import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import type { OptionChainSnapshot, OptionQuote } from '../../src/core/types';
import { bsPrice } from '../../src/indicators/black-scholes';
import { atmIv, expiryStrips, iv30, quoteIv, skew25d } from '../../src/indicators/chain-iv';

const SNAP = '2026-10-09';
const SPOT = 100;
const R = 0.04;

/** Chain priced by Black-Scholes from a vol surface, so the analytics must recover the surface. */
function chain(
  surface: (strike: number, dte: number) => number,
  dtes: number[],
  opts: { omitIv?: boolean } = {},
): OptionChainSnapshot {
  const quotes: OptionQuote[] = [];
  for (const dte of dtes) {
    const expiry = addDays(SNAP, dte);
    for (let k = 70; k <= 110; k += 2.5) {
      const sigma = surface(k, dte);
      const px = bsPrice('P', SPOT, k, dte / 365, R, sigma);
      quotes.push({
        expiry,
        strike: k,
        right: 'P',
        bid: px - 0.01,
        ask: px + 0.01,
        last: px,
        volume: 10,
        openInterest: 100,
        iv: opts.omitIv ? null : sigma,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        multiplier: 100,
      });
    }
  }
  return { snapshotDate: SNAP, underlyingPrice: SPOT, source: 'yahoo', tier: 'real', quotes };
}

describe('chain IV analytics', () => {
  it('quoteIv prefers a plausible quote IV and ignores Yahoo near-zero junk', () => {
    const q: OptionQuote = {
      expiry: '2026-11-13',
      strike: 95,
      right: 'P',
      bid: 1.2,
      ask: 1.3,
      last: 1.25,
      volume: 1,
      openInterest: 1,
      iv: 0.00001,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      multiplier: 100,
    };
    const r = quoteIv(q, 100, 35 / 365, R);
    expect(r?.implied).toBe(true);
    expect(r?.iv).toBeGreaterThan(0.1);
    expect(quoteIv({ ...q, iv: 0.31 }, 100, 35 / 365, R)).toEqual({ iv: 0.31, implied: false });
    expect(quoteIv({ ...q, iv: null, bid: 0, ask: 0.05 }, 100, 35 / 365, R)).toBeNull();
  });

  it('ATM IV interpolates across spot and recovers a flat surface', () => {
    const snap = chain(() => 0.3, [30]);
    const strips = expiryStrips(snap, R);
    expect(atmIv(strips[0]?.points ?? [], SPOT)).toBeCloseTo(0.3, 6);
  });

  it('IV30 interpolates total variance between the expiries bracketing 30 days', () => {
    // term structure: 25 DTE 0.28, 45 DTE 0.34
    const snap = chain((_k, dte) => (dte === 25 ? 0.28 : 0.34), [25, 45]);
    const r = iv30(snap, R);
    expect(r?.extrapolated).toBe(false);
    const t1 = 25 / 365;
    const t2 = 45 / 365;
    const t = 30 / 365;
    const w = 0.28 ** 2 * t1 + ((0.34 ** 2 * t2 - 0.28 ** 2 * t1) * (t - t1)) / (t2 - t1);
    expect(r?.iv30).toBeCloseTo(Math.sqrt(w / t), 4);
    expect(r?.termRatio).toBeCloseTo(0.28 / 0.34, 4);
    expect(r?.frontDte).toBe(25);
  });

  it('uses the nearest expiry and flags it when 30 days is outside the listed expiries', () => {
    const r = iv30(
      chain(() => 0.25, [45, 70]),
      R,
    );
    expect(r?.extrapolated).toBe(true);
    expect(r?.iv30).toBeCloseTo(0.25, 6);
  });

  it('implies IV from mids when the chain carries no IV (CSV paste case)', () => {
    const snap = chain(() => 0.27, [28, 42], { omitIv: true });
    const r = iv30(snap, R);
    expect(r?.usedImpliedFromMid).toBe(true);
    expect(r?.iv30).toBeCloseTo(0.27, 2);
  });

  it('skew25d is positive for a put smile and ~0 for a flat surface', () => {
    const smile = chain((k) => 0.25 + 0.004 * Math.max(0, 100 - k), [30]);
    expect(skew25d(smile, R)).toBeGreaterThan(0.01);
    expect(
      Math.abs(
        skew25d(
          chain(() => 0.25, [30]),
          R,
        ) ?? 1,
      ),
    ).toBeLessThan(1e-4);
  });

  it('returns null with no usable data', () => {
    expect(
      iv30({ snapshotDate: SNAP, underlyingPrice: SPOT, source: 'yahoo', tier: 'real', quotes: [] }, R),
    ).toBeNull();
    expect(
      skew25d(
        chain(() => 0.3, [5]),
        R,
      ),
    ).toBeNull();
  });
});
