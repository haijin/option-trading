import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type { CalibrationRow, CorporateEvent, DailyBar, Reason } from '../../src/core/types';
import { realizedVol } from '../../src/indicators';
import { forwardVrpSeries, ivRankScore, volatilityEdge } from '../../src/skills/s3-volatility-edge';
import { barsFromCloses, bsChain, ctxFor, END, linear, makeHistory, walkCloses } from '../helpers/history';

/** ~1.2% daily vol => RV about 19%. */
const calmCloses = () => walkCloses({ n: 600, start: 100, drift: 0.0003, vol: 0.012, seed: 21 });

function ivPoints(values: number[], withSkew: number | null = null) {
  return values.map((iv30, i) => ({
    day: addDays(END, -(values.length - i)),
    iv30,
    tier: 'real' as const,
    skew25d: withSkew,
  }));
}

describe('IV rank score curve', () => {
  it('30 -> 50, 50 -> 75, 70+ -> 100, 0 -> 0, monotone', () => {
    expect(ivRankScore(0)).toBe(0);
    expect(ivRankScore(30)).toBe(50);
    expect(ivRankScore(50)).toBe(75);
    expect(ivRankScore(70)).toBe(100);
    expect(ivRankScore(95)).toBe(100);
    let prev = -1;
    for (let r = 0; r <= 100; r += 5) {
      expect(ivRankScore(r)).toBeGreaterThanOrEqual(prev);
      prev = ivRankScore(r);
    }
  });
});

describe('S3 volatility.edge', () => {
  it('real tier with a year of stored IV: rank vs real history, PASS with a score', async () => {
    const hist = linear(0.18, 0.3, 120); // today's 0.40 is above all of it
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }),
          ivPoints: ivPoints(hist),
        }),
      ),
    );
    expect(r.payload).toMatchObject({ tier: 'real', ivSource: 'chain', rankBasis: 'real' });
    expect(r.payload.ivRank).toBe(100);
    expect(r.payload.iv30).toBeCloseTo(0.4, 3);
    expect(r.payload.vrpRatio).toBeGreaterThan(1.2);
    expect(r.score).toBeGreaterThan(90);
    // rank 100 with no results date known is "demand IV" (T3): the one WARN on an otherwise clean name
    expect(r.reasons.filter((x) => x.level === 'WARN').map((x) => x.rule)).toEqual(['vol.ivSource']);
    expect(r.payload.ivOrigin).toBe('demand');
    expect(r.verdict).toBe('WARN');
    expect(r.dataQuality.tier).toBe('real');
  });

  it('real chain but little stored history: rank falls back to the vol-index proxy series and says so (data warning)', async () => {
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          chain: bsChain({ spot: 100, sigma: 0.3, dtes: [25, 45] }),
          ivPoints: ivPoints([0.25, 0.26]),
        }),
      ),
    );
    expect(r.payload.rankBasis).toBe('proxy');
    expect(r.reasons.find((x) => x.rule === 'iv.rankOnProxy')).toMatchObject({ level: 'WARN', kind: 'data' });
    expect(r.dataQuality.tier).toBe('proxy');
    expect(r.score).not.toBeNull();
  });

  it('real chain, little history and no vol index: rank on RV60 x ratio history', async () => {
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          volIndexCloses: null,
          chain: bsChain({ spot: 100, sigma: 0.3, dtes: [25, 45] }),
        }),
      ),
    );
    expect(r.payload.rankBasis).toBe('rv');
    expect(r.reasons.some((x) => x.rule === 'iv.rankOnRv')).toBe(true);
  });

  it('proxy tier (no chain): IV30 = vol index x stock/index RV60 beta, labelled iv.proxy', async () => {
    const r = await volatilityEdge.run(ctxFor(makeHistory({ closes: calmCloses() })));
    expect(r.payload).toMatchObject({ tier: 'proxy', ivSource: 'volIndexProxy', rankBasis: 'proxy' });
    expect(r.payload.iv30).toBeGreaterThan(0);
    expect(r.reasons.find((x) => x.rule === 'iv.proxy')).toMatchObject({ level: 'WARN', kind: 'data' });
    expect(r.score).not.toBeNull();
  });

  it('rvOnly tier is NOT scored: score null, verdict NA, composite weights are renormalised by S5 (iv.unscored)', async () => {
    const r = await volatilityEdge.run(ctxFor(makeHistory({ closes: calmCloses(), volIndexCloses: null })));
    expect(r.payload).toMatchObject({ tier: 'rvOnly', ivSource: 'rvOnly', vrpForward: null });
    expect(r.payload.rvRecent).toBeGreaterThan(0);
    expect(r.score).toBeNull();
    expect(r.verdict).toBe('NA');
    expect(r.reasons.map((x) => x.rule)).toEqual(expect.arrayContaining(['iv.rvOnly', 'iv.unscored']));
    expect(r.payload.ivRvRatio).toEqual({ value: 1.15, calibrated: false });
  });

  it('rvOnly uses the calibrated IV/RV ratio once >= 10 chain samples exist for the market, else the 1.15 US / 1.10 HK defaults', async () => {
    const rows: CalibrationRow[] = Array.from({ length: 12 }, (_, i) => ({
      day: addDays(END, -i - 1),
      bucket: '10-20',
      ratio: 0.9,
      ivRvRatio: 1.3,
      source: 'csv',
    }));
    const r = await volatilityEdge.run(
      ctxFor(makeHistory({ closes: calmCloses(), volIndexCloses: null, calibration: rows })),
    );
    expect(r.payload.ivRvRatio).toEqual({ value: 1.3, calibrated: true });
    const hk = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          instrument: { market: 'HK', symbol: '0700', currency: 'HKD' },
          closes: calmCloses(),
          volIndexCloses: null,
        }),
      ),
    );
    expect(hk.payload.ivRvRatio).toEqual({ value: 1.1, calibrated: false });
  });

  it('FAIL when IV rank < 30 AND VRP < 1 (no edge): names the binding rule', async () => {
    // violent stock (RV ~ 48%) but IV 25% and the lowest of its history
    const wild = walkCloses({ n: 600, start: 100, drift: 0.0002, vol: 0.05, seed: 5 });
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: wild,
          chain: bsChain({ spot: 100, sigma: 0.25, dtes: [25, 45] }),
          ivPoints: ivPoints(linear(0.25, 0.6, 120)),
        }),
      ),
    );
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('vol.noEdge');
    expect(r.payload.ivRank).toBeLessThan(30);
    expect(r.payload.vrpRatio).toBeLessThan(1);
  });

  it('WARN (rule) when only one of rank / VRP is weak', async () => {
    const wild = walkCloses({ n: 600, start: 100, drift: 0.0002, vol: 0.05, seed: 5 });
    // rich rank (top of history) but IV below realised vol
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: wild,
          chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }),
          ivPoints: ivPoints(linear(0.2, 0.3, 120)),
        }),
      ),
    );
    expect(r.verdict).toBe('WARN');
    expect(r.reasons.find((x) => x.rule === 'vol.vrp')).toMatchObject({ level: 'WARN', kind: 'rule' });
  });

  it('backwardation (front/next IV > 1.05) costs 15 points and is a rule warning', async () => {
    const hist = ivPoints(linear(0.18, 0.3, 120));
    const flat = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          chain: bsChain({ spot: 100, sigma: 0.35, dtes: [25, 45] }),
          ivPoints: hist,
        }),
      ),
    );
    const back = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          chain: bsChain({ spot: 100, sigma: (_k, dte) => (dte < 30 ? 0.4 : 0.34), dtes: [25, 45] }),
          ivPoints: hist,
        }),
      ),
    );
    expect(back.payload.termRatio).toBeGreaterThan(1.05);
    expect(back.reasons.find((x) => x.rule === 'vol.backwardation')).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(flat.reasons.some((x) => x.rule === 'vol.backwardation')).toBe(false);
    expect((flat.score as number) - (back.score as number)).toBeGreaterThanOrEqual(0);
  });

  it('skew above its 1-year median earns the +5 bonus only with >= 20 stored skew points', async () => {
    const smile = (k: number) => 0.3 + 0.004 * Math.max(0, 100 - k);
    const mk = (skews: number | null) =>
      volatilityEdge.run(
        ctxFor(
          makeHistory({
            closes: calmCloses(),
            chain: bsChain({ spot: 100, sigma: smile, dtes: [25, 45] }),
            ivPoints: ivPoints(linear(0.2, 0.35, 120), skews),
          }),
        ),
      );
    const noHist = await mk(null);
    const withHist = await mk(0.001);
    expect(withHist.reasons.find((x) => x.rule === 'vol.skew')?.passed).toBe(true);
    expect(noHist.reasons.find((x) => x.rule === 'vol.skew')?.passed).toBe(true); // info row
    expect((withHist.score as number) - (noHist.score as number)).toBeGreaterThanOrEqual(0);
  });

  it('no price history: NA with a data warning and tier proxy', async () => {
    const r = await volatilityEdge.run(ctxFor(makeHistory({ closes: linear(100, 101, 30), volIndexCloses: null })));
    expect(r.verdict).toBe('NA');
    expect(r.reasons.some((x) => x.rule === 'iv.noData')).toBe(true);
  });

  it('is deterministic for the same inputs (same params, same data)', async () => {
    const h = makeHistory({ closes: calmCloses() });
    const a = await volatilityEdge.run(ctxFor(h, END, { params: defaultParams() }));
    const b = await volatilityEdge.run(ctxFor(h, END, { params: defaultParams() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------- forward-aligned VRP (trade-skills T1)
const idx = (bars: readonly DailyBar[], day: string) => bars.findIndex((b) => b.day === day);

describe('forwardVrpSeries', () => {
  const closes = calmCloses();
  const bars = barsFromCloses(closes, END);
  const ivAll = new Map(bars.map((b) => [b.day, 0.3] as const));

  it('pairs IV30 at the window start with the realised vol of the next 30 bars; ten windows, non-overlapping, newest ending on the last bar', () => {
    const s = forwardVrpSeries(bars, ivAll, 30, 10);
    expect(s).toHaveLength(10);
    expect(s[9]?.end).toBe(bars[bars.length - 1]?.day);
    const rv = realizedVol(closes, 30);
    for (const o of s) {
      const a = idx(bars, o.day);
      const e = idx(bars, o.end);
      expect(e - a).toBe(30);
      expect(o.rv).toBeCloseTo(rv[e] as number, 12);
      expect(o.iv30).toBe(0.3);
      expect(o.gapPts).toBeCloseTo((0.3 - (rv[e] as number)) * 100, 9);
    }
    for (let i = 1; i < s.length; i++) expect(s[i - 1]?.end).toBe(s[i]?.day); // back to back, no overlap
    expect(s[0]?.day).toBe(bars[bars.length - 1 - 300]?.day);
  });

  it('a start day with no stored IV shifts that window one bar earlier; the rest stay non-overlapping', () => {
    const iv = new Map(ivAll);
    iv.delete(bars[bars.length - 31]?.day as string);
    const s = forwardVrpSeries(bars, iv, 30, 10);
    expect(s).toHaveLength(10);
    expect(s[9]?.end).toBe(bars[bars.length - 2]?.day);
    expect(s[9]?.day).toBe(bars[bars.length - 32]?.day);
    for (let i = 1; i < s.length; i++) expect(s[i - 1]?.end <= (s[i]?.day as string)).toBe(true);
  });

  it('short history: only the windows that fit, oldest first; none when fewer than 31 bars', () => {
    expect(forwardVrpSeries(bars.slice(-100), ivAll, 30, 10)).toHaveLength(3);
    expect(forwardVrpSeries(bars.slice(-61), ivAll, 30, 10)).toHaveLength(2);
    expect(forwardVrpSeries(bars.slice(-30), ivAll, 30, 10)).toEqual([]);
    const s = forwardVrpSeries(bars, ivAll, 30, 3);
    expect(s.map((o) => o.end)).toEqual([bars.at(-61)?.day, bars.at(-31)?.day, bars.at(-1)?.day]);
  });

  it('IV stored on only some days: windows anchor on the days that have one', () => {
    const sparse = new Map<string, number>();
    for (let i = bars.length - 1; i >= 0; i -= 45) sparse.set(bars[i]?.day as string, 0.25); // every 45th bar
    const s = forwardVrpSeries(bars, sparse, 30, 10);
    expect(s.length).toBeGreaterThan(0);
    for (const o of s) expect(sparse.has(o.day)).toBe(true);
    for (let i = 1; i < s.length; i++) expect(s[i - 1]?.end <= (s[i]?.day as string)).toBe(true);
  });
});

describe('S3 forward-aligned VRP rules', () => {
  /** A full stored IV history: one real point per bar at `iv` (a number or a function of the bar index). */
  const withIv = (h: ReturnType<typeof makeHistory>, iv: number | ((i: number) => number)) => {
    h.ivPoints = h.bars.map((b, i) => ({
      day: b.day,
      iv30: typeof iv === 'number' ? iv : iv(i),
      tier: 'real' as const,
      skew25d: null,
    }));
    return h;
  };
  const earningsAt = (date: string): CorporateEvent => ({
    type: 'earnings',
    date,
    confirmed: true,
    source: 'manual',
    knownAt: '2026-01-01T00:00:00.000Z',
    details: null,
  });
  const byRule = (r: { reasons: Reason[] }, rule: string) => r.reasons.find((x) => x.rule === rule);

  it('implied above the vol that followed in all ten windows: PASS vol.vrpForward, gap and live rows, measured payload', async () => {
    // calm stock (RV ~ 19%) that always traded with IV30 30%: selling it paid every month
    const r = await volatilityEdge.run(
      ctxFor(
        withIv(makeHistory({ closes: calmCloses(), chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }) }), 0.3),
      ),
    );
    expect(r.payload.rankBasis).toBe('real');
    const f = r.payload.vrpForward;
    expect(f).not.toBeNull();
    if (!f) return;
    expect(f).toMatchObject({ window: 30, observations: 10, above: 10 });
    expect(f.meanGapPts).toBeGreaterThan(5);
    expect(f.series).toHaveLength(10);
    expect(f.series[9]?.end).toBe(END);
    expect(byRule(r, 'vol.vrpForward')).toMatchObject({ level: 'PASS', value: 10 });
    expect(byRule(r, 'vol.vrpGap')).toMatchObject({ level: 'INFO' });
    expect(byRule(r, 'vol.vrpLive')).toMatchObject({ level: 'INFO' });
    expect((byRule(r, 'vol.vrpLive')?.value as number) > 0).toBe(true); // 40% live vs ~19% realised
    expect(byRule(r, 'vol.vrpUnmeasured')).toBeUndefined();
    expect(byRule(r, 'vol.vrp')?.note).toMatch(/trailing/);
    expect(r.payload.rvRecent).toBeGreaterThan(0.1);
    expect(r.payload.rvRecent).toBeLessThan(0.3);
    // the only WARN is the T3 demand-IV note (high rank, no dated result)
    expect(r.reasons.filter((x) => x.level === 'WARN').map((x) => x.rule)).toEqual(['vol.ivSource']);
    expect(r.verdict).toBe('WARN');
  });

  it('structurally negative (implied below subsequent realised in >= 6 of 10) with no dated result inside the expiry window: FAIL vol.noEdge even at IV rank 100', async () => {
    // calm stock (RV ~ 19%) that always traded with IV30 10%: selling it lost every month; today the chain says 40%
    const r = await volatilityEdge.run(
      ctxFor(
        withIv(makeHistory({ closes: calmCloses(), chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }) }), 0.1),
      ),
    );
    expect(r.payload.ivRank).toBe(100);
    expect(r.payload.vrpRatio).toBeGreaterThan(1); // the trailing test is fooled
    expect(r.payload.vrpForward).toMatchObject({ observations: 10, above: 0 });
    expect(byRule(r, 'vol.vrpForward')).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(r.verdict).toBe('FAIL');
    const f = r.reasons.find((x) => x.level === 'FAIL');
    expect(f?.rule).toBe('vol.noEdge');
    expect(f?.note).toMatch(/no result date is known/);
  });

  it('structurally negative with a dated result inside the expiry window: WARN only (event premium may explain it)', async () => {
    const h = withIv(
      makeHistory({
        closes: calmCloses(),
        chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }),
        events: [earningsAt(addDays(END, 20))],
      }),
      0.1,
    );
    const r = await volatilityEdge.run(ctxFor(h));
    expect(byRule(r, 'vol.vrpForward')).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(r.reasons.some((x) => x.level === 'FAIL')).toBe(false);
    expect(r.verdict).toBe('WARN');
    // a result beyond the window does not count
    const far = withIv(
      makeHistory({
        closes: calmCloses(),
        chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }),
        events: [earningsAt(addDays(END, 90))],
      }),
      0.1,
    );
    const r2 = await volatilityEdge.run(ctxFor(far));
    expect(r2.verdict).toBe('FAIL');
    expect(r2.reasons.find((x) => x.level === 'FAIL')?.note).toMatch(/outside the expiry window/);
  });

  it('positive forward VRP at a low IV rank with a poor trailing ratio stays sellable: INFO vol.lowRankSize instead of FAIL vol.noEdge', async () => {
    // 575 calm bars then 25 violent ones: RV20 ~ 70% so trailing IV/RV < 1, and today's 25% IV ranks below the
    // 30% history. Nine of the ten forward windows still had implied above realised.
    const calm = calmCloses().slice(0, 575);
    const wild = walkCloses({ n: 25, start: calm[calm.length - 1] as number, drift: 0, vol: 0.05, seed: 9 });
    const h = withIv(
      makeHistory({
        closes: [...calm, ...wild],
        chain: bsChain({ spot: wild[wild.length - 1] as number, sigma: 0.25, dtes: [25, 45] }),
      }),
      0.3,
    );
    const r = await volatilityEdge.run(ctxFor(h));
    expect(r.payload.ivRank).toBeLessThan(30);
    expect(r.payload.vrpRatio).toBeLessThan(1);
    expect(r.payload.vrpForward?.above).toBe(9);
    expect(r.reasons.some((x) => x.rule === 'vol.noEdge')).toBe(false);
    expect(byRule(r, 'vol.lowRankSize')).toMatchObject({ level: 'INFO' });
    expect(r.verdict).toBe('WARN'); // the IV-rank rule warning still applies
    // the same name with the forward series unmeasured keeps the old FAIL
    h.ivPoints = h.ivPoints.slice(-120); // only 4 months of stored IV: rank still real, forward windows short
    const old = await volatilityEdge.run(ctxFor(h));
    expect(old.payload.rankBasis).toBe('real');
    expect(byRule(old, 'vol.vrpUnmeasured')).toMatchObject({ level: 'INFO' });
    expect(old.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('vol.noEdge');
  });

  it('proxy rank basis (little stored IV): INFO vol.vrpUnmeasured, no forward rows, not counted against the name', async () => {
    const r = await volatilityEdge.run(
      ctxFor(
        makeHistory({
          closes: calmCloses(),
          chain: bsChain({ spot: 100, sigma: 0.3, dtes: [25, 45] }),
          ivPoints: ivPoints([0.25, 0.26]),
        }),
      ),
    );
    expect(r.payload.rankBasis).toBe('proxy');
    expect(r.payload.vrpForward).toBeNull();
    expect(byRule(r, 'vol.vrpUnmeasured')).toMatchObject({ level: 'INFO', passed: true });
    expect(byRule(r, 'vol.vrpUnmeasured')?.note).toMatch(/proxy/);
    expect(byRule(r, 'vol.vrpForward')).toBeUndefined();
    expect(r.verdict).not.toBe('FAIL');
    // the proxy tier (no chain at all) says the same
    const proxy = await volatilityEdge.run(ctxFor(makeHistory({ closes: calmCloses() })));
    expect(proxy.payload.tier).toBe('proxy');
    expect(byRule(proxy, 'vol.vrpUnmeasured')).toMatchObject({ level: 'INFO' });
    expect(proxy.payload.rvRecent).toBeGreaterThan(0);
  });

  it('short real history: INFO vol.vrpUnmeasured names how many windows exist', async () => {
    const h = withIv(
      makeHistory({ closes: calmCloses(), chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }) }),
      0.3,
    );
    h.ivPoints = h.ivPoints.slice(-120);
    const r = await volatilityEdge.run(ctxFor(h));
    expect(r.payload.rankBasis).toBe('real');
    expect(r.payload.vrpForward).toBeNull();
    expect(byRule(r, 'vol.vrpUnmeasured')).toMatchObject({ level: 'INFO', value: 3 });
  });

  it('thresholds come from the strategy params, not the code', async () => {
    const p = defaultParams();
    p['volatility.edge'].vrpNegativeMin = 11; // never structurally negative
    p['volatility.edge'].vrpPositiveMin = 11; // never positive either
    const h = withIv(
      makeHistory({ closes: calmCloses(), chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }) }),
      0.1,
    );
    const r = await volatilityEdge.run(ctxFor(h, END, { params: p }));
    expect(byRule(r, 'vol.vrpForward')).toMatchObject({ level: 'INFO' });
    expect(r.reasons.filter((x) => x.level === 'WARN').map((x) => x.rule)).toEqual(['vol.ivSource']);
    expect(r.verdict).toBe('WARN');
    const q = defaultParams();
    q['volatility.edge'].vrpObservations = 4;
    q['volatility.edge'].vrpWindowDays = 20;
    const short = withIv(
      makeHistory({ closes: calmCloses(), chain: bsChain({ spot: 100, sigma: 0.4, dtes: [25, 45] }) }),
      0.3,
    );
    short.ivPoints = short.ivPoints.slice(-120);
    const r2 = await volatilityEdge.run(ctxFor(short, END, { params: q }));
    expect(r2.payload.vrpForward).toMatchObject({ window: 20, observations: 4, above: 4 });
  });
});

describe('S3 IV source and IV floor (T3)', () => {
  const earningsAt = (date: string): CorporateEvent => ({
    type: 'earnings',
    date,
    confirmed: true,
    source: 'manual',
    knownAt: '2026-01-01T00:00:00.000Z',
    details: null,
  });
  const byRule = (r: { reasons: Reason[] }, rule: string) => r.reasons.find((x) => x.rule === rule);
  /** Real chain at 40% vol with a front-heavy (frontIv / nextIv) term structure, a year of stored IV below it. */
  const richName = (o: { term?: 'front' | 'flat'; ivHist?: number[]; events?: CorporateEvent[] } = {}) =>
    makeHistory({
      closes: calmCloses(),
      chain: bsChain({
        spot: 100,
        sigma: (_k, dte) => (o.term === 'front' ? (dte < 35 ? 0.46 : 0.4) : 0.4),
        dtes: [25, 45],
      }),
      ivPoints: ivPoints(o.ivHist ?? linear(0.18, 0.3, 120)),
      events: o.events ?? [],
    });

  it('results within 14 days and a front-heavy term ratio: INFO event IV (will crush on the date)', async () => {
    const r = await volatilityEdge.run(ctxFor(richName({ term: 'front', events: [earningsAt(addDays(END, 10))] })));
    expect(r.payload.ivOrigin).toBe('event');
    expect(r.payload.daysToResults).toBe(10);
    expect(byRule(r, 'vol.ivSource')).toMatchObject({ level: 'INFO', value: 'event' });
    expect(byRule(r, 'vol.ivSource')?.note).toContain('event IV, will crush');
  });

  it('results within 14 days but a flat term structure is not event IV: unknown', async () => {
    const r = await volatilityEdge.run(ctxFor(richName({ term: 'flat', events: [earningsAt(addDays(END, 10))] })));
    expect(r.payload.ivOrigin).toBe('unknown');
    expect(byRule(r, 'vol.ivSource')).toMatchObject({ level: 'INFO', value: 'unknown' });
  });

  it('no result within 45 days (or none known) and IV rank above ivrMin: rule WARN demand IV (may persist)', async () => {
    const far = await volatilityEdge.run(ctxFor(richName({ events: [earningsAt(addDays(END, 60))] })));
    expect(far.payload.ivOrigin).toBe('demand');
    expect(byRule(far, 'vol.ivSource')).toMatchObject({ level: 'WARN', kind: 'rule', value: 'demand' });
    expect(byRule(far, 'vol.ivSource')?.note).toContain('demand IV, may persist');
    const none = await volatilityEdge.run(ctxFor(richName()));
    expect(none.payload.ivOrigin).toBe('demand');
    expect(none.payload.daysToResults).toBeNull();
  });

  it('a result 20 days out with a flat term structure, or a low IV rank, is unknown (INFO)', async () => {
    const mid = await volatilityEdge.run(ctxFor(richName({ events: [earningsAt(addDays(END, 20))] })));
    expect(mid.payload.ivOrigin).toBe('unknown');
    // today's 40% sits inside a history that reaches 60%: rank well under 30
    const low = await volatilityEdge.run(ctxFor(richName({ ivHist: linear(0.38, 0.6, 120) })));
    expect(low.payload.ivRank).toBeLessThan(30);
    expect(low.payload.ivOrigin).toBe('unknown');
    expect(byRule(low, 'vol.ivSource')).toMatchObject({ level: 'INFO', value: 'unknown' });
  });

  it('the term ratio falls back to the latest stored iv_daily.term_ratio when there is no live chain', async () => {
    const h = makeHistory({
      closes: calmCloses(),
      chain: null,
      volIndexCloses: linear(30, 30, 600),
      events: [earningsAt(addDays(END, 7))],
    });
    h.ivPoints = ivPoints(linear(0.18, 0.3, 120)).map((p, i, a) => ({
      ...p,
      termRatio: i === a.length - 1 ? 1.2 : null,
    }));
    const r = await volatilityEdge.run(ctxFor(h));
    expect(r.payload.tier).toBe('proxy');
    expect(r.payload.termRatio).toBe(1.2);
    expect(r.payload.ivOrigin).toBe('event');
  });

  it('IV percentile at or below 10 with results 30 to 60 days out: rule WARN vol.ivFloorRamp (the gate treats it as Wait)', async () => {
    // a year of stored IV above today's 40%: percentile 0
    const floor = (days: number) =>
      richName({ ivHist: linear(0.45, 0.8, 120), events: [earningsAt(addDays(END, days))] });
    const r = await volatilityEdge.run(ctxFor(floor(45)));
    expect(r.payload.ivPercentile).toBeLessThanOrEqual(10);
    expect(byRule(r, 'vol.ivFloorRamp')).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(byRule(r, 'vol.ivFloorRamp')?.note).toContain('IV ramp ahead');
    expect(r.verdict).not.toBe('PASS');
    // outside the 30 to 60 day window the rule is silent
    expect(byRule(await volatilityEdge.run(ctxFor(floor(29))), 'vol.ivFloorRamp')).toBeUndefined();
    expect(byRule(await volatilityEdge.run(ctxFor(floor(61))), 'vol.ivFloorRamp')).toBeUndefined();
    // and so is it when the percentile is not at the floor
    const rich = await volatilityEdge.run(ctxFor(richName({ events: [earningsAt(addDays(END, 45))] })));
    expect(rich.payload.ivPercentile).toBeGreaterThan(10);
    expect(byRule(rich, 'vol.ivFloorRamp')).toBeUndefined();
  });

  it('thresholds of both rules come from the strategy params', async () => {
    const p = defaultParams();
    p['volatility.edge'].ivSourceDemandDays = 100; // a result 60 days out is now "dated": not demand
    p['volatility.edge'].ivFloorPercentileMax = 100; // every percentile is "the floor"
    p['volatility.edge'].ivFloorRampMinDays = 55;
    p['volatility.edge'].ivFloorRampMaxDays = 65;
    const r = await volatilityEdge.run(
      ctxFor(richName({ events: [earningsAt(addDays(END, 60))] }), END, { params: p }),
    );
    expect(r.payload.ivOrigin).toBe('unknown');
    expect(byRule(r, 'vol.ivFloorRamp')).toBeDefined();
  });
});
