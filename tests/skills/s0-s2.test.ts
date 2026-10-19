import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params';
import { marketRegime } from '../../src/skills/s0-market-regime';
import { technicalTiming } from '../../src/skills/s2-technical-timing';
import { barsFromCloses, ctxFor, END, linear, makeHistory, walkCloses } from '../helpers/history';

const up = (n = 400, from = 100, to = 160) => linear(from, to, n);
const down = (n = 400, from = 160, to = 100) => linear(from, to, n);

describe('S0 market.regime', () => {
  const run = (indexCloses: number[], vol: number[] | null) =>
    marketRegime.run(ctxFor(makeHistory({ indexCloses, volIndexCloses: vol })));

  it('bull_calm: index above its 200d SMA and vol index < 20', async () => {
    const r = await run(up(), linear(15, 15, 400));
    expect(r.payload).toMatchObject({ regime: 'bull_calm', deployCapPct: 0.5, deltaCap: 0.3, usedVolIndex: true });
    expect(r.verdict).toBe('NA');
    expect(r.dataQuality).toEqual({ tier: 'real', missing: [] });
    expect(r.payload.indexVsSma200Pct).toBeGreaterThan(0);
  });

  it('bull_volatile: vol index 20-30', async () => {
    const r = await run(up(), linear(25, 25, 400));
    expect(r.payload).toMatchObject({ regime: 'bull_volatile', deployCapPct: 0.5, deltaCap: 0.25 });
  });

  it('bear_calm: below the 200d SMA with vol < 25', async () => {
    const r = await run(down(400, 160, 150), linear(22, 22, 400));
    expect(r.payload).toMatchObject({ regime: 'bear_calm', deployCapPct: 0.3, deltaCap: 0.2 });
  });

  it('panic: vol index > 30, or index 10%+ below its SMA200, or below SMA200 with vol 25-30 (table gap, conservative)', async () => {
    expect((await run(up(), linear(35, 35, 400))).payload.regime).toBe('panic');
    expect((await run(down(400, 200, 100), linear(18, 18, 400))).payload.regime).toBe('panic');
    expect((await run(down(400, 160, 150), linear(27, 27, 400))).payload.regime).toBe('panic');
    expect((await run(up(), linear(35, 35, 400))).payload).toMatchObject({ deployCapPct: 0.25, deltaCap: 0.15 });
  });

  it('crash_guard: vol index > 40 FAILs and blocks new entries; the override param turns it into NA', async () => {
    const r = await run(up(), linear(45, 45, 400));
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('regime.crashGuard');
    const p = defaultParams();
    p['market.regime'].overrideCrashGuard = true;
    const o = await marketRegime.run(
      ctxFor(makeHistory({ indexCloses: up(), volIndexCloses: linear(45, 45, 400) }), END, { params: p }),
    );
    expect(o.verdict).toBe('NA');
    expect(o.reasons.some((x) => x.rule === 'regime.crashGuardOverridden')).toBe(true);
  });

  it('regime.noVolIndex: classifies on index vs SMA200 only and says so (VHSI has no free history)', async () => {
    const r = await run(up(), null);
    expect(r.payload).toMatchObject({ regime: 'bull_volatile', usedVolIndex: false, volIndex: null });
    expect(r.reasons.find((x) => x.rule === 'regime.noVolIndex')).toMatchObject({ level: 'WARN', kind: 'data' });
    expect(r.dataQuality).toEqual({ tier: 'proxy', missing: ['volIndex'] });
    expect((await run(down(400, 160, 150), null)).payload.regime).toBe('bear_calm');
    expect((await run(down(400, 200, 100), null)).payload.regime).toBe('panic');
  });

  it('a vol index whose last bar lags the index by more than 5 days counts as missing', async () => {
    const h = makeHistory({ indexCloses: up(), volIndexCloses: linear(15, 15, 400) });
    h.volIndexBars = h.volIndexBars.slice(0, -10);
    const r = await marketRegime.run(ctxFor(h));
    expect(r.payload.usedVolIndex).toBe(false);
  });

  it('too little index history defaults to bear_calm with a data warning, never a crash', async () => {
    const r = await run(up(120), linear(15, 15, 120));
    expect(r.payload.regime).toBe('bear_calm');
    expect(r.reasons.some((x) => x.rule === 'regime.insufficientIndexHistory')).toBe(true);
  });
});

describe('S2 technical.timing', () => {
  const run = (closes: number[], over: Parameters<typeof makeHistory>[0] = {}) =>
    technicalTiming.run(ctxFor(makeHistory({ closes, ...over })));

  /** Uptrend, then a dip: close stays above SMA200, RSI falls into the pullback zone. */
  const pullback = () => [...linear(100, 160, 330), ...linear(160, 147, 20)];

  it('uptrend pullback above SMA200: PASS, trend and pullback components fire, support below spot', async () => {
    const r = await run(pullback());
    expect(r.verdict).toBe('PASS');
    expect(r.payload.trendState).toBe('up');
    expect(r.payload.sma200).toBeLessThan(r.payload.close as number);
    expect(r.payload.support).toBeLessThan(r.payload.close as number);
    expect(r.payload.components.trend?.ratio).toBe(1);
    expect(r.score).toBeGreaterThan(40);
    expect(r.dataQuality.tier).toBe('real');
    expect(r.reasons.find((x) => x.rule === 'technical.trend')?.weight).toBe(25);
  });

  it('support is the highest candidate below spot and carries its source', async () => {
    const r = await run(pullback());
    const cands = r.payload.supportCandidates;
    expect(cands.length).toBeGreaterThan(0);
    const best = cands.reduce((a, b) => (b.level > a.level ? b : a));
    expect(r.payload.support).toBe(best.level);
    expect(r.payload.supportSource).toBe(best.source);
    for (const c of cands) expect(c.level).toBeLessThan(r.payload.close as number);
  });

  it('close below SMA200: WARN (rule-based, halves sizing downstream)', async () => {
    const r = await run([...linear(160, 120, 330), ...linear(120, 118, 20)]);
    expect(r.verdict).toBe('WARN');
    const w = r.reasons.find((x) => x.rule === 'trend.belowSma200');
    expect(w).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(r.payload.components.trend?.ratio).toBe(0);
  });

  it('falling knife (ADX > 30, -DI dominant, below SMA200, 3m return < -20%): FAIL', async () => {
    const r = await run([...linear(150, 130, 270), ...linear(130, 80, 80)]);
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('technical.fallingKnife');
    expect(r.payload.ret3m).toBeLessThan(-0.2);
  });

  it('no level below spot: synthetic support = spot - 2 x ATR with a data warning', async () => {
    // steady at 100, then the last bar gaps to 80 with no intrabar range: spot sits below the 20d low, SMA50/200, the prior
    // month low and the lower Bollinger band, so no candidate is strictly below it
    const closes = [...linear(100, 100, 299), 80];
    const bars = barsFromCloses(closes, END, 'US', { range: 0 });
    const r = await technicalTiming.run(ctxFor(makeHistory({ bars })));
    expect(r.payload.supportSource).toBe('synthetic');
    expect(r.reasons.find((x) => x.rule === 'support.synthetic')).toMatchObject({ kind: 'data' });
    expect(r.payload.support).toBeCloseTo(80 - 2 * (r.payload.atr14 as number), 6);
  });

  it('a perfectly flat window gives no RSI (TA-Lib would report 0 = "oversold")', async () => {
    const r = await run(linear(100, 100, 300));
    expect(r.payload.rsi14).toBeNull();
    expect(r.dataQuality.missing).toContain('rsi14');
  });

  it('fewer than 30 bars: NA, not scored, data warning', async () => {
    const r = await run(linear(100, 110, 20));
    expect(r.verdict).toBe('NA');
    expect(r.score).toBeNull();
    expect(r.reasons[0]?.rule).toBe('technical.insufficientBars');
  });

  it('under 200 bars still scores from what exists: sma200 missing, tier proxy, weights renormalised', async () => {
    const r = await run(walkCloses({ n: 120, start: 100, drift: 0.001, vol: 0.01, seed: 3 }));
    expect(r.dataQuality.tier).toBe('proxy');
    expect(r.dataQuality.missing).toContain('sma200');
    expect(r.score).not.toBeNull();
    expect(r.payload.components.trend?.ratio).toBeNull();
  });

  it('relative strength compares 3-month return with the index', async () => {
    const strong = await run(up(400, 100, 200), { indexCloses: linear(100, 101, 400) });
    expect(strong.payload.components.rs?.ratio).toBe(1);
    const weak = await run(
      linear(100, 100, 400).map((c, i) => (i > 370 ? c * 0.8 : c)),
      { indexCloses: up(400, 100, 140) },
    );
    expect(weak.payload.components.rs?.ratio).toBe(0);
  });

  it('heavy down-day volume (distribution) zeroes the volume component', async () => {
    const closes = pullback();
    const bars = barsFromCloses(closes, END, 'US', { volume: (i) => (i >= closes.length - 3 ? 5_000_000 : 1_000_000) });
    const r = await technicalTiming.run(ctxFor(makeHistory({ bars })));
    expect(r.payload.components.volume?.ratio).toBe(0);
  });

  it('indicator series are published to the run memo for S3/S4', async () => {
    const memo = new Map<string, unknown>();
    await technicalTiming.run(ctxFor(makeHistory({ closes: pullback() }), END, { memo }));
    expect(memo.has('ta.series')).toBe(true);
  });
});
