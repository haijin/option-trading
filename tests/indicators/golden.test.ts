import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  fractalLows,
  macd,
  rsi,
  sma,
  trueRange,
  yangZhangVol,
} from '../../src/indicators';
import { expectSeriesClose, firstNonNull, loadGolden, loadOhlcv } from './helpers';

/**
 * Compares the TypeScript indicators against fixtures in tests/fixtures/golden, produced by
 * tests/fixtures/gen/gen_indicators.py (TA-Lib for SMA/EMA/RSI/ATR/TRANGE/MACD/BBANDS/ADX/DI; independent
 * pure-python references for Donchian, fractal lows and Yang-Zhang). Both the values (1e-6) and the null
 * pattern (= warm-up length) must match.
 */
const bars = loadOhlcv();
const { open, high, low, close } = bars;

describe('fixture sanity', () => {
  it('has 500 consistent bars', () => {
    expect(close).toHaveLength(500);
    expect(bars.dates[0]).toBe('2022-01-03');
    for (let i = 0; i < close.length; i++) {
      expect(high[i]!).toBeGreaterThanOrEqual(Math.max(open[i]!, close[i]!));
      expect(low[i]!).toBeLessThanOrEqual(Math.min(open[i]!, close[i]!));
      expect(Number.isInteger(bars.volume[i])).toBe(true);
    }
  });
});

describe('golden: moving averages', () => {
  it.each([
    [20, 19],
    [50, 49],
    [200, 199],
  ])('SMA(%i) warms up at index %i and matches TA-Lib', (period, first) => {
    const actual = sma(close, period);
    expect(firstNonNull(actual)).toBe(first);
    expectSeriesClose(actual, loadGolden(`sma_${period}`).value!, `sma_${period}`);
  });

  it.each([
    [12, 11],
    [26, 25],
  ])('EMA(%i) warms up at index %i and matches TA-Lib', (period, first) => {
    const actual = ema(close, period);
    expect(firstNonNull(actual)).toBe(first);
    expectSeriesClose(actual, loadGolden(`ema_${period}`).value!, `ema_${period}`);
  });
});

describe('golden: momentum and volatility', () => {
  it.each([14, 7])('RSI(%i) matches TA-Lib (first value at index = period)', (period) => {
    const actual = rsi(close, period);
    expect(firstNonNull(actual)).toBe(period);
    expectSeriesClose(actual, loadGolden(`rsi_${period}`).value!, `rsi_${period}`);
  });

  it('RSI default period is 14', () => {
    expect(rsi(close)).toEqual(rsi(close, 14));
  });

  it('TRANGE matches TA-Lib (index 0 null)', () => {
    const actual = trueRange(high, low, close);
    expect(firstNonNull(actual)).toBe(1);
    expectSeriesClose(actual, loadGolden('trange').value!, 'trange');
  });

  it.each([14, 5])('ATR(%i) matches TA-Lib (first value at index = period)', (period) => {
    const actual = atr(high, low, close, period);
    expect(firstNonNull(actual)).toBe(period);
    expectSeriesClose(actual, loadGolden(`atr_${period}`).value!, `atr_${period}`);
  });

  it('ATR default period is 14', () => {
    expect(atr(high, low, close)).toEqual(atr(high, low, close, 14));
  });
});

describe('golden: MACD', () => {
  it.each([
    [12, 26, 9, 33],
    [8, 21, 5, 24],
  ])('MACD(%i,%i,%i) matches TA-Lib, all three lines start at index %i', (fast, slow, signal, first) => {
    const actual = macd(close, fast, slow, signal);
    const golden = loadGolden(`macd_${fast}_${slow}_${signal}`);
    expect(firstNonNull(actual.macd)).toBe(first);
    expect(firstNonNull(actual.signal)).toBe(first);
    expect(firstNonNull(actual.hist)).toBe(first);
    expectSeriesClose(actual.macd, golden.macd!, 'macd');
    expectSeriesClose(actual.signal, golden.signal!, 'signal');
    expectSeriesClose(actual.hist, golden.hist!, 'hist');
  });

  it('defaults are 12/26/9', () => {
    expect(macd(close)).toEqual(macd(close, 12, 26, 9));
  });
});

describe('golden: Bollinger Bands', () => {
  it.each([
    [20, 2, 'bbands_20_2', 19],
    [10, 1.5, 'bbands_10_1p5', 9],
  ])('BBANDS(%i, %f) matches TA-Lib', (period, k, name, first) => {
    const actual = bollinger(close, period, k);
    const golden = loadGolden(name);
    expect(firstNonNull(actual.middle)).toBe(first);
    expectSeriesClose(actual.upper, golden.upper!, `${name}.upper`);
    expectSeriesClose(actual.middle, golden.middle!, `${name}.middle`);
    expectSeriesClose(actual.lower, golden.lower!, `${name}.lower`);
  });

  it('defaults are 20 / 2', () => {
    expect(bollinger(close)).toEqual(bollinger(close, 20, 2));
  });
});

describe('golden: ADX / +DI / -DI', () => {
  it.each([14, 7])('ADX(%i) matches TA-Lib: DI from index = period, ADX from 2*period-1', (period) => {
    const actual = adx(high, low, close, period);
    const golden = loadGolden(`adx_${period}`);
    expect(firstNonNull(actual.plusDi)).toBe(period);
    expect(firstNonNull(actual.minusDi)).toBe(period);
    expect(firstNonNull(actual.adx)).toBe(2 * period - 1);
    expectSeriesClose(actual.adx, golden.adx!, `adx_${period}.adx`);
    expectSeriesClose(actual.plusDi, golden.plus_di!, `adx_${period}.plusDi`);
    expectSeriesClose(actual.minusDi, golden.minus_di!, `adx_${period}.minusDi`);
  });

  it('default period is 14', () => {
    expect(adx(high, low, close)).toEqual(adx(high, low, close, 14));
  });
});

describe('golden: Donchian, fractals, Yang-Zhang (pure-python references)', () => {
  it.each([
    [20, 19],
    [55, 54],
  ])('Donchian(%i) including the current bar, first value at index %i', (period, first) => {
    const actual = donchian(high, low, period);
    const golden = loadGolden(`donchian_${period}`);
    expect(firstNonNull(actual.upper)).toBe(first);
    expect(firstNonNull(actual.lower)).toBe(first);
    expectSeriesClose(actual.upper, golden.upper!, `donchian_${period}.upper`);
    expectSeriesClose(actual.lower, golden.lower!, `donchian_${period}.lower`);
  });

  it('5-bar fractal lows match the reference; the last two bars are never marked', () => {
    const actual = fractalLows(low);
    expectSeriesClose(actual, loadGolden('fractal_lows').value!, 'fractal_lows');
    expect(actual.slice(-2)).toEqual([null, null]);
    expect(actual.slice(0, 2)).toEqual([null, null]);
    expect(actual.filter((x) => x !== null).length).toBeGreaterThan(20);
  });

  it('Yang-Zhang(20) matches the independent python implementation, first value at index 20', () => {
    const actual = yangZhangVol(
      bars.dates.map((_, i) => ({ open: open[i]!, high: high[i]!, low: low[i]!, close: close[i]! })),
      20,
    );
    expect(firstNonNull(actual)).toBe(20);
    expectSeriesClose(actual, loadGolden('yang_zhang_20').value!, 'yang_zhang_20');
  });
});
