import { describe, expect, it } from 'vitest';
import * as ind from '../../src/indicators';

/**
 * Property tests over random inputs: no function mutates its inputs (they are frozen, so any write throws a
 * TypeError in strict mode, and a deep copy is compared afterwards), output series are fresh arrays aligned 1:1
 * with the input, and results are deterministic.
 */

// Small deterministic PRNG (mulberry32) so failures are reproducible without extra dependencies.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RandomBars {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  bars: { open: number; high: number; low: number; close: number }[];
}

function randomBars(n: number, rand: () => number): RandomBars {
  const out: RandomBars = { open: [], high: [], low: [], close: [], bars: [] };
  let prev = 50 + rand() * 100;
  for (let i = 0; i < n; i++) {
    const open = prev * (1 + (rand() - 0.5) * 0.02);
    const close = open * (1 + (rand() - 0.5) * 0.04);
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    out.open.push(open);
    out.high.push(high);
    out.low.push(low);
    out.close.push(close);
    out.bars.push({ open, high, low, close });
    prev = close;
  }
  return out;
}

function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x as object)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

type Output = unknown;

/** Every series-returning indicator applied to the same random bars. */
function runAll(b: RandomBars): Record<string, Output> {
  return {
    sma: ind.sma(b.close, 5),
    ema: ind.ema(b.close, 5),
    rsi: ind.rsi(b.close, 7),
    trueRange: ind.trueRange(b.high, b.low, b.close),
    atr: ind.atr(b.high, b.low, b.close, 5),
    macd: ind.macd(b.close, 6, 13, 4),
    bollinger: ind.bollinger(b.close, 10, 2),
    adx: ind.adx(b.high, b.low, b.close, 5),
    donchian: ind.donchian(b.high, b.low, 8),
    fractalLows: ind.fractalLows(b.low),
    fractalHighs: ind.fractalHighs(b.high),
    avwap: ind.avwap(
      b.high,
      b.low,
      b.close,
      b.close.map((c) => Math.round(c * 10)),
      Math.min(2, b.close.length),
    ),
    unfilledGapUps: ind.unfilledGapUps(b.high, b.low, 12),
    rollingMin: ind.rollingMin(b.close, 4),
    rollingMax: ind.rollingMax(b.close, 4),
    rollingMean: ind.rollingMean(b.close, 4),
    pctChange: ind.pctChange(b.close, 3),
    logReturns: ind.logReturns(b.close),
    realizedVol: ind.realizedVol(b.close, 6),
    yangZhangVol: ind.yangZhangVol(b.bars, 6),
  };
}

function seriesOf(o: Output): (number | null)[][] {
  return Array.isArray(o) ? [o as (number | null)[]] : Object.values(o as Record<string, (number | null)[]>);
}

describe('purity', () => {
  it('no indicator mutates its (frozen) inputs, and outputs are aligned, fresh and deterministic', () => {
    const rand = rng(12345);
    for (let trial = 0; trial < 40; trial++) {
      const n = trial === 0 ? 0 : Math.floor(rand() * 90);
      const b = randomBars(n, rand);
      const before = JSON.stringify(b);
      deepFreeze(b);

      const first = runAll(b);
      const second = runAll(b);
      expect(JSON.stringify(b)).toBe(before);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));

      for (const [name, out] of Object.entries(first)) {
        for (const s of seriesOf(out)) {
          expect(s, `${name} length`).toHaveLength(n);
          for (const input of [b.open, b.high, b.low, b.close]) expect(s).not.toBe(input);
          for (const x of s) expect(x === null || Number.isFinite(x), `${name} finite-or-null`).toBe(true);
        }
      }
    }
  });

  it('helpers and rank functions do not mutate frozen inputs', () => {
    const rand = rng(777);
    for (let trial = 0; trial < 30; trial++) {
      const xs = deepFreeze(Array.from({ length: 1 + Math.floor(rand() * 50) }, () => rand() * 100 - 20));
      const copy = [...xs];
      ind.mean(xs);
      ind.median(xs);
      ind.stdev(xs);
      ind.variance(xs);
      ind.populationStdev(xs);
      ind.percentileRank(xs, rand() * 100);
      ind.rankInRange(xs, rand() * 100);
      expect(xs).toEqual(copy);
    }
  });

  it('pure scalar functions are deterministic (same inputs, same outputs)', () => {
    const a = ind.bsGreeks('P', 100, 95, 0.25, 0.04, 0.3, 0.01);
    expect(ind.bsGreeks('P', 100, 95, 0.25, 0.04, 0.3, 0.01)).toEqual(a);
    const px = ind.bsPrice('P', 100, 95, 0.25, 0.04, 0.3, 0.01);
    expect(ind.impliedVol('P', px, 100, 95, 0.25, 0.04, 0.01)).toBe(ind.impliedVol('P', px, 100, 95, 0.25, 0.04, 0.01));
  });

  it('exports the full public API', () => {
    const names = [
      'normCdf',
      'normPdf',
      'normInv',
      'sma',
      'ema',
      'rsi',
      'trueRange',
      'atr',
      'macd',
      'bollinger',
      'adx',
      'donchian',
      'fractalLows',
      'fractalHighs',
      'avwap',
      'unfilledGapUps',
      'rollingMin',
      'rollingMax',
      'rollingMean',
      'pctChange',
      'bsPrice',
      'bsGreeks',
      'impliedVol',
      'probItm',
      'probTouchApprox',
      'expectedPutLossGivenItm',
      'expectedPutPayoff',
      'logReturns',
      'realizedVol',
      'yangZhangVol',
      'percentileRank',
      'rankInRange',
      'median',
      'stdev',
      'mean',
    ];
    for (const name of names) expect(typeof (ind as Record<string, unknown>)[name], name).toBe('function');
  });
});
