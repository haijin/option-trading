import { describe, expect, it } from 'vitest';
import { avwap, fractalHighs, fractalLows, unfilledGapUps } from '../../src/indicators';

describe('avwap: anchored volume-weighted average price', () => {
  // typical prices: (12+8+10)/3 = 10, (13+9+11)/3 = 11, (15+9+12)/3 = 12, (11+7+9)/3 = 9
  const high = [12, 13, 15, 11];
  const low = [8, 9, 9, 7];
  const close = [10, 11, 12, 9];
  const volume = [100, 200, 100, 300];

  it('is null before the anchor and the cumulative typical-price x volume mean after it', () => {
    const out = avwap(high, low, close, volume, 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(11, 12); // 11
    expect(out[2]).toBeCloseTo((11 * 200 + 12 * 100) / 300, 12); // 11.3333
    expect(out[3]).toBeCloseTo((11 * 200 + 12 * 100 + 9 * 300) / 600, 12); // 10.1667
  });

  it('anchored at the first bar it is the whole-series vwap', () => {
    const out = avwap(high, low, close, volume, 0);
    expect(out[0]).toBeCloseTo(10, 12);
    expect(out[3]).toBeCloseTo((10 * 100 + 11 * 200 + 12 * 100 + 9 * 300) / 700, 12);
  });

  it('is aligned with the input; an anchor outside it gives all nulls; zero volume stays null', () => {
    expect(avwap(high, low, close, volume, 4)).toEqual([null, null, null, null]);
    expect(avwap(high, low, close, volume, -1)).toEqual([null, null, null, null]);
    expect(avwap([1, 2], [1, 2], [1, 2], [0, 0], 0)).toEqual([null, null]);
    expect(avwap([], [], [], [], 0)).toEqual([]);
    expect(() => avwap(high, low, close, volume, 1.5)).toThrow(RangeError);
  });
});

describe('unfilledGapUps', () => {
  //            0    1    2     3     4     5
  const high = [10, 11, 13.5, 14, 14.2, 15];
  const low = [9, 10, 12, 12.5, 13, 13.4];

  it('marks the top of a gap-up that no later low has traded back into', () => {
    // bar 2 gaps over bar 1's high (11): low 12 > 11, and no later low is <= 11 -> unfilled, value = low[2] = 12
    const out = unfilledGapUps(high, low, 10);
    expect(out).toEqual([null, null, 12, null, null, null]);
  });

  it('a later low at or below the gap bottom fills it', () => {
    const filled = unfilledGapUps(high, [...low.slice(0, 5), 10.9], 10);
    expect(filled).toEqual([null, null, null, null, null, null]);
    const touching = unfilledGapUps(high, [...low.slice(0, 5), 11], 10);
    expect(touching[2]).toBeNull();
  });

  it('only the last `lookback` bars are examined', () => {
    expect(unfilledGapUps(high, low, 3)).toEqual([null, null, null, null, null, null]);
    expect(unfilledGapUps(high, low, 4)[2]).toBe(12);
  });

  it('two open gaps are both reported; a gap-down is not a gap-up; empty input gives []', () => {
    const h = [10, 11, 13, 14, 16];
    const l = [9, 10, 12, 13, 15.5];
    expect(unfilledGapUps(h, l, 10)).toEqual([null, null, 12, null, 15.5]);
    expect(unfilledGapUps([10, 8], [9, 7], 5)).toEqual([null, null]);
    expect(unfilledGapUps([], [], 5)).toEqual([]);
    expect(() => unfilledGapUps(h, l, 0)).toThrow(RangeError);
  });
});

describe('fractalHighs', () => {
  it('is the mirror of fractalLows: strictly higher than two bars each side, last two always null', () => {
    const high = [1, 2, 5, 2, 1, 3, 9, 4, 3];
    expect(fractalHighs(high)).toEqual([null, null, 5, null, null, null, 9, null, null]);
    expect(fractalHighs(high)).toEqual(fractalLows(high.map((x) => -x)).map((v) => (v === null ? null : -v)));
  });

  it('a tie is not a fractal', () => {
    expect(fractalHighs([1, 2, 5, 5, 1, 0, 0])).toEqual([null, null, null, null, null, null, null]);
  });
});
