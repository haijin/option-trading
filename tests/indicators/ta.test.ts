import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  fractalLows,
  macd,
  pctChange,
  rollingMax,
  rollingMean,
  rollingMin,
  rsi,
  sma,
  trueRange,
} from '../../src/indicators';
import { loadOhlcv } from './helpers';

describe('rolling windows', () => {
  it('rollingMean / sma: first value at period-1', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(rollingMean([1, 2, 3, 4, 5], 1)).toEqual([1, 2, 3, 4, 5]);
    expect(rollingMean([1, 2, 3, 4, 5], 5)).toEqual([null, null, null, null, 3]);
  });

  it('rollingMin / rollingMax include the current bar', () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(rollingMin(v, 3)).toEqual([null, null, 1, 1, 1, 1, 2, 2]);
    expect(rollingMax(v, 3)).toEqual([null, null, 4, 4, 5, 9, 9, 9]);
  });

  it('window longer than the input gives all nulls; empty input gives []', () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
    expect(rollingMax([1, 2], 3)).toEqual([null, null]);
    expect(sma([], 3)).toEqual([]);
  });

  it('non-finite values make the windows containing them null', () => {
    expect(rollingMin([1, Number.NaN, 3, 4], 2)).toEqual([null, null, null, 3]);
    expect(rollingMean([1, 2, Number.NaN, 4, 5], 2)).toEqual([null, 1.5, null, null, 4.5]);
  });

  it('pctChange is the simple return over lag bars', () => {
    expect(pctChange([100, 110, 121], 1)).toEqual([null, expect.closeTo(0.1, 12), expect.closeTo(0.1, 12)]);
    expect(pctChange([100, 110, 121], 2)).toEqual([null, null, expect.closeTo(0.21, 12)]);
    expect(pctChange([0, 5, 6], 1)).toEqual([null, null, expect.closeTo(0.2, 12)]);
    expect(pctChange([1], 3)).toEqual([null]);
  });

  it('rejects invalid periods', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError);
    expect(() => rollingMax([1, 2, 3], -2)).toThrow(RangeError);
    expect(() => pctChange([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first period values, alpha = 2/(period+1)', () => {
    // seed at idx 2 = mean(1,2,3) = 2; alpha = 0.5
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([10, 11, 12, 13, 14, 20], 4);
    expect(e.slice(0, 3)).toEqual([null, null, null]);
    expect(e[3]).toBeCloseTo(11.5, 12);
    expect(e[4]).toBeCloseTo(11.5 + 0.4 * (14 - 11.5), 12);
    expect(e[5]).toBeCloseTo(11.5 + 0.4 * 2.5 + 0.4 * (20 - (11.5 + 0.4 * 2.5)), 12);
  });

  it('period 1 is the identity', () => {
    expect(ema([4, 7, 1], 1)).toEqual([4, 7, 1]);
  });
});

describe('rsi', () => {
  it('hand-computed Wilder smoothing', () => {
    // changes +1, -1 -> avgGain = avgLoss = 0.5 -> RSI 50 at index 2; then +1: gain .75, loss .25 -> 75
    const r = rsi([1, 2, 1, 2], 2);
    expect(r).toEqual([null, null, 50, 75]);
  });

  it('monotone series saturate at 100 / 0', () => {
    const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i));
    const down = rsi(Array.from({ length: 30 }, (_, i) => 100 - i));
    expect(up.slice(14).every((x) => x === 100)).toBe(true);
    expect(down.slice(14).every((x) => x === 0)).toBe(true);
  });

  it('TA-Lib quirk: a completely flat window gives 0', () => {
    expect(rsi(Array(20).fill(50))[14]).toBe(0);
  });

  it('too-short input gives nulls; output stays within [0, 100] on real data', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
    for (const x of rsi(loadOhlcv().close)) if (x !== null) expect(x >= 0 && x <= 100).toBe(true);
  });
});

describe('trueRange / atr', () => {
  it('uses the previous close for gaps', () => {
    // bar 1 gaps up: prevClose 10, high 12, low 11 -> TR = 12 - 10 = 2 (not high - low = 1)
    expect(trueRange([10, 12], [9, 11], [10, 11.5])).toEqual([null, 2]);
    // gap down: prevClose 10, high 9, low 8 -> TR = 10 - 8 = 2
    expect(trueRange([10, 9], [9, 8], [10, 8.5])).toEqual([null, 2]);
    // inside bar: TR = high - low
    expect(trueRange([10, 10.5], [9, 9.5], [10, 10])).toEqual([null, 1]);
  });

  it('atr(1) equals TR from index 1', () => {
    const { high, low, close } = loadOhlcv();
    const tr = trueRange(high, low, close);
    const a = atr(high, low, close, 1);
    expect(a[0]).toBeNull();
    for (let i = 1; i < tr.length; i++) expect(a[i]).toBeCloseTo(tr[i]!, 12);
  });

  it('atr seed is the plain mean of TR[1..period]', () => {
    const { high, low, close } = loadOhlcv();
    const tr = trueRange(high, low, close);
    const seed = tr.slice(1, 15).reduce<number>((s, x) => s + x!, 0) / 14;
    expect(atr(high, low, close)[14]).toBeCloseTo(seed, 12);
  });
});

describe('macd', () => {
  it('swaps fast and slow when fast > slow (TA-Lib behaviour)', () => {
    const { close } = loadOhlcv();
    expect(macd(close, 26, 12, 9)).toEqual(macd(close, 12, 26, 9));
  });

  it('hist = macd - signal; zero on a constant series', () => {
    const m = macd(Array(80).fill(42));
    for (let i = 33; i < 80; i++) {
      expect(m.macd[i]).toBeCloseTo(0, 12);
      expect(m.signal[i]).toBeCloseTo(0, 12);
      expect(m.hist[i]).toBeCloseTo(0, 12);
    }
    const { close } = loadOhlcv();
    const r = macd(close);
    for (let i = 33; i < close.length; i++) expect(r.hist[i]).toBeCloseTo(r.macd[i]! - r.signal[i]!, 12);
  });

  it('input shorter than the warm-up gives all nulls', () => {
    const m = macd(Array.from({ length: 33 }, (_, i) => i));
    expect(m.macd.every((x) => x === null)).toBe(true);
    expect(macd([]).macd).toEqual([]);
  });
});

describe('bollinger', () => {
  it('bands collapse onto the middle for a constant series', () => {
    const b = bollinger(Array(30).fill(10), 20, 2);
    expect(b.middle[19]).toBe(10);
    expect(b.upper[19]).toBe(10);
    expect(b.lower[29]).toBe(10);
  });

  it('uses the population standard deviation', () => {
    // window [1,2,3]: mean 2, population sd = sqrt(2/3)
    const b = bollinger([1, 2, 3], 3, 2);
    expect(b.middle[2]).toBe(2);
    expect(b.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 12);
    expect(b.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 12);
  });
});

describe('adx', () => {
  it('identifies a clean uptrend: +DI >> -DI and ADX high, all within 0..100', () => {
    const n = 120;
    const close = Array.from({ length: n }, (_, i) => 100 + i);
    const high = close.map((c) => c + 1);
    const low = close.map((c) => c - 1);
    const r = adx(high, low, close);
    expect(r.adx[n - 1]!).toBeGreaterThan(90);
    expect(r.plusDi[n - 1]!).toBeGreaterThan(r.minusDi[n - 1]!);
    expect(r.minusDi[n - 1]!).toBe(0);
    for (const s of [r.adx, r.plusDi, r.minusDi])
      for (const x of s) if (x !== null) expect(x >= 0 && x <= 100).toBe(true);
  });

  it('a flat market has no direction (all zero, no NaN)', () => {
    const flat = Array(60).fill(50);
    const r = adx(flat, flat, flat);
    expect(r.adx[59]).toBe(0);
    expect(r.plusDi[59]).toBe(0);
    expect(r.minusDi[59]).toBe(0);
  });
});

describe('donchian', () => {
  it('upper / lower include the current bar', () => {
    const high = [5, 6, 7, 6, 5, 8];
    const low = [3, 4, 5, 4, 3, 2];
    const d = donchian(high, low, 3);
    expect(d.upper).toEqual([null, null, 7, 7, 7, 8]);
    expect(d.lower).toEqual([null, null, 3, 4, 3, 2]);
  });
});

describe('fractalLows', () => {
  it('marks strict 5-bar lows only', () => {
    const low = [5, 4, 3, 4, 5, 4, 3, 2, 3, 4];
    expect(fractalLows(low)).toEqual([null, null, 3, null, null, null, null, 2, null, null]);
  });

  it('ties are not fractals', () => {
    expect(fractalLows([5, 4, 3, 3, 5, 6, 7])).toEqual(Array(7).fill(null));
    expect(fractalLows([5, 4, 3, 4, 3, 6, 7])[2]).toBeNull(); // low[4] == low[2]
  });

  it('is unconfirmed (null) for the last two bars and tolerates short input', () => {
    expect(fractalLows([5, 4, 3, 2, 1])).toEqual(Array(5).fill(null));
    expect(fractalLows([3, 1, 3])).toEqual([null, null, null]);
    expect(fractalLows([])).toEqual([]);
  });
});
