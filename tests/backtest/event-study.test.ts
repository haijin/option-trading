import { describe, expect, it } from 'vitest';
import {
  builtInRules,
  type RuleBar,
  runEventStudy,
  type StudyBar,
  strikeForPutDelta,
} from '../../src/backtest/event-study';
import { mulberry32 } from '../../src/backtest/metrics';
import { addDays } from '../../src/core/dates';
import { bsGreeks, bsPrice } from '../../src/indicators/black-scholes';

function ruleBars(closes: number[], spread = 0): RuleBar[] {
  return closes.map((c) => ({ close: c, high: c + spread, low: c - spread, volume: 1000 }));
}

function rule(id: string, bars: RuleBar[]) {
  const r = builtInRules(bars).find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
}

describe('strikeForPutDelta', () => {
  it('produces a strike with the requested put delta', () => {
    for (const [sigma, t, r] of [
      [0.2, 30 / 365, 0],
      [0.45, 45 / 365, 0.04],
    ] as const) {
      const k = strikeForPutDelta(100, t, r, sigma, 0.25);
      expect(k).toBeLessThan(100);
      expect(bsGreeks('P', 100, k, t, r, sigma).delta).toBeCloseTo(-0.25, 9);
    }
  });
});

describe('builtInRules', () => {
  it('exposes the five documented ids', () => {
    const ids = builtInRules(ruleBars(Array.from({ length: 30 }, () => 100))).map((r) => r.id);
    expect(ids).toEqual(['rsi.pullback', 'trend.aboveSma200', 'bb.lowerTouch', 'sma50.rising', 'support.nearLow20']);
  });

  it('rsi.pullback fires for RSI 40 and not for a straight rally', () => {
    // 7 x (+1, -1.5): initial average gain 0.5, loss 0.75 -> RSI = 100 * 0.5 / 1.25 = 40 at index 14
    const closes = [100];
    for (let k = 0; k < 7; k++) closes.push(closes.at(-1)! + 1, closes.at(-1)! + 1 - 1.5);
    const r = rule('rsi.pullback', ruleBars(closes));
    expect(r.fires(14)).toBe(true);
    expect(r.fires(5)).toBe(false); // warm-up
    const rally = rule('rsi.pullback', ruleBars(Array.from({ length: 40 }, (_, i) => 100 + i)));
    expect(rally.fires(30)).toBe(false); // RSI 100
  });

  it('trend.aboveSma200 and sma50.rising need warm-up and a rising series', () => {
    const up = ruleBars(Array.from({ length: 260 }, (_, i) => 100 + i));
    expect(rule('trend.aboveSma200', up).fires(250)).toBe(true);
    expect(rule('trend.aboveSma200', up).fires(100)).toBe(false);
    expect(rule('sma50.rising', up).fires(120)).toBe(true);
    expect(rule('sma50.rising', up).fires(60)).toBe(false); // sma50 starts at index 49; 20 bars earlier is warm-up
    const down = ruleBars(Array.from({ length: 260 }, (_, i) => 400 - i));
    expect(rule('trend.aboveSma200', down).fires(250)).toBe(false);
    expect(rule('sma50.rising', down).fires(120)).toBe(false);
  });

  it('bb.lowerTouch fires on a spike below the band within the last 5 bars', () => {
    // 29 alternating closes (100, 102): lower band 99, lows = closes. Then a drop to 90.
    const closes = Array.from({ length: 29 }, (_, i) => (i % 2 === 0 ? 100 : 102));
    const quiet = rule('bb.lowerTouch', ruleBars(closes));
    expect(quiet.fires(28)).toBe(false);
    const r = rule('bb.lowerTouch', ruleBars([...closes, 90, 101, 101, 101, 101, 101]));
    expect(r.fires(29)).toBe(true); // 90 <= lower band
    expect(r.fires(33)).toBe(true); // still within 5 bars
    expect(r.fires(34)).toBe(false); // the touch (bar 29) is now 5 bars back, outside i-4..i
  });

  it('support.nearLow20 requires the close within one ATR of the 20-day low', () => {
    // flat 100 with a +-1 range: low20 = 99, ATR = 2, close - low = 1 <= 2
    const flat = Array.from({ length: 30 }, () => 100);
    expect(rule('support.nearLow20', ruleBars(flat, 1)).fires(29)).toBe(true);
    // a 20 % jump on the last bar puts the close ~21 above the low, far beyond one ATR
    const jump = ruleBars([...flat.slice(0, 29), 120], 1);
    expect(rule('support.nearLow20', jump).fires(29)).toBe(false);
    expect(rule('support.nearLow20', jump).fires(5)).toBe(false); // warm-up
  });

  it('is lookahead-free: perturbing future bars never changes fires(i)', () => {
    const rand = mulberry32(42);
    let p = 100;
    const closes: number[] = [];
    for (let i = 0; i < 500; i++) {
      p *= 1 + (rand() - 0.5) * 0.05;
      closes.push(p);
    }
    const base = closes.map((c) => ({ close: c, high: c * 1.01, low: c * 0.99, volume: 1000 }));
    const cut = 300;
    const perturbed = base.map((b, i) =>
      i < cut ? b : { close: b.close * 3, high: b.high * 4, low: b.low * 0.2, volume: 5 },
    );
    const a = builtInRules(base);
    const b = builtInRules(perturbed);
    for (let k = 0; k < a.length; k++) {
      for (let i = 0; i < cut; i++) expect(b[k]!.fires(i)).toBe(a[k]!.fires(i));
    }
    // sanity: the perturbation does change something at or after the cut
    let changed = false;
    for (let k = 0; k < a.length; k++) {
      for (let i = cut; i < cut + 200; i++) changed ||= a[k]!.fires(i) !== b[k]!.fires(i);
    }
    expect(changed).toBe(true);
  });
});

describe('runEventStudy', () => {
  const START = '2024-01-01';
  const flatBars = (n: number, over: (i: number) => Partial<StudyBar> = () => ({})): StudyBar[] =>
    Array.from({ length: n }, (_, i) => ({ day: addDays(START, i), close: 100, adjClose: 100, ...over(i) }));
  const opts = { sigma: () => 0.2, rate: 0, horizons: [30] };

  it('counts events, skips windows that exceed the data, and captures full premium on flat prices', () => {
    // 40 daily bars: i + 30 <= 39 -> i in 0..9 are evaluable
    const res = runEventStudy(flatBars(40), { id: 'first', fires: (i) => i === 0 }, opts);
    expect(res.rule).toBe('first');
    const h = res.byHorizon[0]!;
    expect(h.horizon).toBe(30);
    expect(h.nFired).toBe(1);
    expect(h.nNotFired).toBe(9);
    expect(h.fired).toMatchObject({ n: 1, meanFwd: 0, medianFwd: 0, touchRate: 0, meanCapture: 1, winRate: 1 });
    expect(h.notFired.meanCapture).toBe(1);
    expect(h.edge).toEqual({ winRateDelta: 0, touchRateDelta: 0 });
  });

  it('measures touch rates before expiry with the low, excluding the entry bar', () => {
    // Day 5 trades down to 80 intraday (strike is ~96.4) but closes at 100
    const bars = flatBars(40, (i) => (i === 5 ? { low: 80 } : {}));
    const res = runEventStudy(bars, { id: 'early', fires: (i) => i < 5 }, opts);
    const h = res.byHorizon[0]!;
    expect(h.nFired).toBe(5); // i = 0..4, window includes day 5
    expect(h.nNotFired).toBe(5); // i = 5..9, day 5 is not after the entry bar
    expect(h.fired.touchRate).toBe(1);
    expect(h.notFired.touchRate).toBe(0);
    expect(h.edge.touchRateDelta).toBe(1);
    // closing at 100 means the put still expires worthless: captured in both groups
    expect(h.edge.winRateDelta).toBe(0);
  });

  it('uses the close when no low is supplied', () => {
    const bars = flatBars(40, (i) => (i === 5 ? { close: 90, adjClose: 90 } : {}));
    const res = runEventStudy(bars, { id: 'early', fires: (i) => i < 5 }, opts);
    expect(res.byHorizon[0]!.fired.touchRate).toBe(1);
  });

  it('computes expiry capture and forward return from the expiry bar', () => {
    // 31 bars (days 0..30): only i = 0 is evaluable. Expiry close 80, adjClose 82
    const bars = flatBars(31, (i) => (i === 30 ? { close: 80, adjClose: 82, low: 80 } : {}));
    const res = runEventStudy(bars, { id: 'r', fires: () => true }, opts);
    const h = res.byHorizon[0]!;
    const t = 30 / 365;
    const k = strikeForPutDelta(100, t, 0, 0.2, 0.25);
    const prem = bsPrice('P', 100, k, t, 0, 0.2);
    expect(h.nFired).toBe(1);
    expect(h.nNotFired).toBe(0);
    expect(h.fired.meanFwd).toBeCloseTo(-0.18, 12);
    expect(h.fired.touchRate).toBe(1);
    expect(h.fired.meanCapture).toBeCloseTo((prem - (k - 80)) / prem, 12);
    expect(h.fired.meanCapture!).toBeLessThan(0);
    expect(h.fired.winRate).toBe(0);
    expect(h.notFired.meanCapture).toBeNull();
    expect(h.edge).toEqual({ winRateDelta: null, touchRateDelta: null });
  });

  it('picks the strike for the requested delta', () => {
    const bars = flatBars(31, (i) => (i === 30 ? { close: 94, adjClose: 94, low: 94 } : {}));
    const run = (d: number) =>
      runEventStudy(bars, { id: 'r', fires: () => true }, { ...opts, strikeDeltaTarget: d }).byHorizon[0]!.fired
        .meanCapture!;
    // at 94: the 25-delta strike (~96.4) ends in the money, the 10-delta strike (~92.9) expires worthless
    expect(run(0.1)).toBeCloseTo(1, 12);
    expect(run(0.25)).toBeLessThan(0);
    expect(() => run(0)).toThrow(RangeError);
  });

  it('skips bars where sigma is unavailable and supports several horizons', () => {
    const res = runEventStudy(
      flatBars(60),
      { id: 'r', fires: () => true },
      { sigma: (i) => (i < 5 ? null : 0.3), rate: 0.02, horizons: [30, 45] },
    );
    expect(res.byHorizon.map((h) => h.horizon)).toEqual([30, 45]);
    expect(res.byHorizon[0]!.nFired).toBe(25); // i = 5..29 (i + 30 <= 59)
    expect(res.byHorizon[1]!.nFired).toBe(10); // i = 5..14
  });

  it('defaults to 30 and 45 day horizons and returns empty stats on short data', () => {
    const res = runEventStudy(flatBars(10), { id: 'r', fires: () => true }, { sigma: () => 0.2, rate: 0 });
    expect(res.byHorizon.map((h) => h.horizon)).toEqual([30, 45]);
    expect(res.byHorizon[0]!.nFired).toBe(0);
    expect(res.byHorizon[0]!.fired.meanFwd).toBeNull();
  });

  it('works end to end with a built-in rule and gives finite numbers', () => {
    const rand = mulberry32(3);
    let p = 100;
    const bars: (StudyBar & RuleBar)[] = Array.from({ length: 400 }, (_, i) => {
      p *= 1 + (rand() - 0.5) * 0.03;
      return { day: addDays(START, i), close: p, adjClose: p, high: p * 1.01, low: p * 0.99, volume: 1 };
    });
    const res = runEventStudy(bars, rule('trend.aboveSma200', bars), { sigma: () => 0.25, rate: 0.03 });
    for (const h of res.byHorizon) {
      expect(h.nFired + h.nNotFired).toBeGreaterThan(100);
      for (const v of [h.fired.meanFwd, h.fired.touchRate, h.notFired.meanCapture, h.edge.winRateDelta]) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
