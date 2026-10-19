import { describe, expect, it } from 'vitest';
import {
  logReturns,
  mean,
  median,
  percentileRank,
  populationStdev,
  rankInRange,
  realizedVol,
  stdev,
  variance,
  yangZhangVol,
} from '../../src/indicators';
import { loadOhlcv } from './helpers';

const bars = loadOhlcv();
const ohlc = bars.close.map((_, i) => ({
  open: bars.open[i]!,
  high: bars.high[i]!,
  low: bars.low[i]!,
  close: bars.close[i]!,
}));

describe('logReturns', () => {
  it('ln(c[i] / c[i-1]) with index 0 null', () => {
    const r = logReturns([100, 110, 99]);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(Math.log(1.1), 14);
    expect(r[2]).toBeCloseTo(Math.log(0.9), 14);
  });

  it('non-positive prices give null; empty input gives []', () => {
    expect(logReturns([100, 0, 50, -1, 20])).toEqual([null, null, null, null, null]);
    expect(logReturns([])).toEqual([]);
  });
});

describe('realizedVol', () => {
  it('is 0 for a constant-return series', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    const v = realizedVol(closes, 20);
    expect(v.slice(0, 20).every((x) => x === null)).toBe(true);
    for (let i = 20; i < closes.length; i++) expect(v[i]).toBeCloseTo(0, 10);
  });

  it('alternating +/- r returns: sample stdev = r * sqrt(n / (n - 1)), annualised', () => {
    const r = 0.01;
    const n = 20;
    const closes = [100];
    for (let i = 1; i <= 40; i++) closes.push(closes[i - 1]! * Math.exp(i % 2 === 1 ? r : -r));
    const v = realizedVol(closes, n);
    const expected = r * Math.sqrt(n / (n - 1)) * Math.sqrt(252);
    expect(v[n]).toBeCloseTo(expected, 12);
    expect(v[40]).toBeCloseTo(expected, 12);
    expect(realizedVol(closes, n, 365)[n]).toBeCloseTo(r * Math.sqrt(n / (n - 1)) * Math.sqrt(365), 12);
  });

  it('first value at index = window (needs window + 1 closes)', () => {
    const v = realizedVol([100, 101, 99, 102, 100, 103], 3);
    expect(v.map((x) => x === null)).toEqual([true, true, true, false, false, false]);
    const rets = [Math.log(101 / 100), Math.log(99 / 101), Math.log(102 / 99)];
    expect(v[3]).toBeCloseTo(stdev(rets) * Math.sqrt(252), 12);
  });

  it('matches python statistics.stdev * sqrt(252) on the 500-bar fixture', () => {
    // reference values computed with python: statistics.stdev(log returns of the last w closes) * sqrt(252)
    const v20 = realizedVol(bars.close, 20);
    expect(v20[20]).toBeCloseTo(0.1844241027588478, 12);
    expect(v20[100]).toBeCloseTo(0.14498394366061204, 12);
    expect(v20[499]).toBeCloseTo(0.3664711616597685, 12);
    expect(realizedVol(bars.close, 60)[499]).toBeCloseTo(0.3489035508545848, 12);
    expect(realizedVol(bars.close, 5)[250]).toBeCloseTo(0.16621779453254504, 12);
  });

  it('rejects windows < 2 and tolerates short input', () => {
    expect(() => realizedVol([1, 2, 3], 1)).toThrow(RangeError);
    expect(realizedVol([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(realizedVol([], 5)).toEqual([]);
  });

  it('is null for windows containing a non-positive price', () => {
    const v = realizedVol([100, 101, 0, 102, 103, 104, 105], 2);
    expect(v[2]).toBeNull();
    expect(v[3]).toBeNull();
    expect(v[4]).toBeNull();
    expect(v[5]).not.toBeNull();
  });
});

describe('yangZhangVol', () => {
  it('has its first value at index = window', () => {
    const v = yangZhangVol(ohlc, 20);
    expect(v.findIndex((x) => x !== null)).toBe(20);
    expect(v).toHaveLength(500);
  });

  it('is 0 for flat bars with no gaps', () => {
    const flat = Array.from({ length: 30 }, () => ({ open: 50, high: 50, low: 50, close: 50 }));
    expect(yangZhangVol(flat, 10)[10]).toBe(0);
  });

  it('reduces to the overnight-return stdev when bars have no intraday range', () => {
    // each bar is a single price (O = H = L = C): only the overnight term survives
    const px = [100, 102, 99, 101, 104, 103, 107, 105, 108, 110, 109, 112];
    const flatBars = px.map((p) => ({ open: p, high: p, low: p, close: p }));
    const n = 8;
    const v = yangZhangVol(flatBars, n);
    const overnight: number[] = [];
    for (let i = px.length - n; i < px.length; i++) overnight.push(Math.log(px[i]! / px[i - 1]!));
    expect(v[px.length - 1]).toBeCloseTo(stdev(overnight) * Math.sqrt(252), 12);
  });

  it('is invariant to the price scale and scales with sqrt(tradingDays)', () => {
    const scaled = ohlc.map((b) => ({ open: b.open * 7, high: b.high * 7, low: b.low * 7, close: b.close * 7 }));
    const a = yangZhangVol(ohlc, 20);
    const b = yangZhangVol(scaled, 20);
    for (let i = 20; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 10);
    const c = yangZhangVol(ohlc, 20, 365);
    expect(c[300]!).toBeCloseTo(a[300]! * Math.sqrt(365 / 252), 10);
  });

  it('is positive and in a sane range on the fixture', () => {
    for (const x of yangZhangVol(ohlc, 20)) if (x !== null) expect(x > 0.01 && x < 2).toBe(true);
  });

  it('rejects windows < 2, short input gives nulls, accepts extra bar fields', () => {
    expect(() => yangZhangVol(ohlc, 1)).toThrow(RangeError);
    expect(yangZhangVol(ohlc.slice(0, 20), 20).every((x) => x === null)).toBe(true);
    expect(yangZhangVol([], 20)).toEqual([]);
    const withExtras = ohlc.slice(0, 30).map((b, i) => ({ ...b, volume: 1000 + i, date: `d${i}` }));
    expect(yangZhangVol(withExtras, 10)[10]).not.toBeNull();
  });
});

describe('percentileRank', () => {
  const series = [10, 20, 30, 40, 50];

  it('is the share strictly below the value (0-100)', () => {
    expect(percentileRank(series, 30)).toBe(40);
    expect(percentileRank(series, 35)).toBe(60);
    expect(percentileRank(series, 10)).toBe(0);
    expect(percentileRank(series, 50)).toBe(80);
  });

  it('values outside the range', () => {
    expect(percentileRank(series, -100)).toBe(0);
    expect(percentileRank(series, 51)).toBe(100);
    expect(percentileRank(series, 1e9)).toBe(100);
  });

  it('flat series: nothing is strictly below an equal value', () => {
    expect(percentileRank([5, 5, 5, 5], 5)).toBe(0);
    expect(percentileRank([5, 5, 5, 5], 6)).toBe(100);
    expect(percentileRank([5, 5, 5, 5], 4)).toBe(0);
  });

  it('empty series (or only non-finite entries) is NaN; NaN value is NaN', () => {
    expect(percentileRank([], 1)).toBeNaN();
    expect(percentileRank([Number.NaN], 1)).toBeNaN();
    expect(percentileRank(series, Number.NaN)).toBeNaN();
  });

  it('ignores non-finite entries', () => {
    expect(percentileRank([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30], 25)).toBeCloseTo((2 / 3) * 100, 12);
  });
});

describe('rankInRange', () => {
  const series = [10, 20, 30, 40, 50];

  it('is (value - min) / (max - min) * 100', () => {
    expect(rankInRange(series, 10)).toBe(0);
    expect(rankInRange(series, 50)).toBe(100);
    expect(rankInRange(series, 30)).toBe(50);
    expect(rankInRange(series, 15)).toBe(12.5);
  });

  it('clamps values outside the range to 0..100', () => {
    expect(rankInRange(series, 5)).toBe(0);
    expect(rankInRange(series, 1000)).toBe(100);
  });

  it('null for an empty or flat series, or NaN value', () => {
    expect(rankInRange([], 5)).toBeNull();
    expect(rankInRange([7, 7, 7], 7)).toBeNull();
    expect(rankInRange([7], 7)).toBeNull();
    expect(rankInRange(series, Number.NaN)).toBeNull();
    expect(rankInRange([Number.NaN], 1)).toBeNull();
  });

  it('ignores non-finite entries', () => {
    expect(rankInRange([Number.NaN, 0, 10, Number.POSITIVE_INFINITY], 5)).toBe(50);
  });
});

describe('stats helpers', () => {
  it('mean / median / variance / stdev / populationStdev', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    expect(median(xs)).toBe(4.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(populationStdev(xs)).toBe(2);
    expect(variance(xs)).toBeCloseTo(32 / 7, 12);
    expect(stdev(xs)).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it('undefined cases are NaN', () => {
    expect(mean([])).toBeNaN();
    expect(median([])).toBeNaN();
    expect(stdev([1])).toBeNaN();
    expect(variance([])).toBeNaN();
    expect(populationStdev([])).toBeNaN();
    expect(populationStdev([4])).toBe(0);
  });
});
