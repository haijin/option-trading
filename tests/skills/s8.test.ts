import { describe, expect, it } from 'vitest';
import { LEVEL_FAMILY } from '../../src/core/leaders';
import { defaultParams } from '../../src/core/params';
import type { DailyBar } from '../../src/core/types';
import { ema } from '../../src/indicators';
import { ALL_SKILLS, SKILLS, STANDALONE_SKILLS, topoSort } from '../../src/skills/registry';
import { leaderRule, leadersPullback, leadersScreen } from '../../src/skills/s8-leaders-pullback';
import { BASE_CLOSES, BASE_LEN, leaderBars, N, RANKS, run } from '../helpers/leaders';

/** The range high prints on the first base bar (it opens at the peak close), one bar after the peak close. */
const LEN = BASE_LEN - 1;

describe('S8 leaders.pullback: registration', () => {
  it('is registered as a standalone skill: in ALL_SKILLS, never in the sell-put pipeline order', () => {
    expect(leadersPullback.id).toBe('leaders.pullback');
    expect(leadersPullback.dependsOn).toEqual(['market.regime']);
    expect(leadersPullback.paramKey).toBe('leaders.pullback');
    expect(leadersPullback.cacheable).toBe(true);
    expect(STANDALONE_SKILLS.map((s) => s.id)).toEqual(['leaders.pullback']);
    expect(ALL_SKILLS.map((s) => s.id)).toContain('leaders.pullback');
    expect(SKILLS.map((s) => s.id)).not.toContain('leaders.pullback');
    expect(topoSort().map((s) => s.id)).not.toContain('leaders.pullback');
    expect(
      topoSort(ALL_SKILLS)
        .map((s) => s.id)
        .indexOf('market.regime'),
    ).toBeLessThan(
      topoSort(ALL_SKILLS)
        .map((s) => s.id)
        .indexOf('leaders.pullback'),
    );
  });
});

describe('S8 leaders.pullback: a run-up, a base and a turn-up bar', () => {
  it('is a Setup with the stop under the lower of today and yesterday, shares from 0.5% risk, and 3R / 5R', async () => {
    const bars = leaderBars();
    const r = await run({ bars });
    const p = r.payload;
    expect(p.state).toBe('setup');
    expect(r.verdict).toBe('PASS');
    expect(p.reached).toBe('consolidating');
    expect(p.isLeader).toBe(true);
    expect(p.turnUp).toBe(true);
    expect(p.inPlay).not.toBeNull();
    expect(p.base?.len).toBe(LEN);
    expect(p.base?.depth).toBeGreaterThan(0.04);
    expect(p.base?.depth).toBeLessThan(0.25);
    expect(p.regime).toBe('bull_calm');
    expect(p.posture).toBe('entries');

    const last = bars[N - 1] as DailyBar;
    const prev = bars[N - 2] as DailyBar;
    const stop = Math.min(last.low, prev.low) * (1 - 0.002);
    const plan = p.plan;
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.entry).toBeCloseTo(last.close, 2);
    expect(plan.stop).toBeCloseTo(stop, 2);
    const rPrice = last.close - stop;
    expect(plan.r).toBeCloseTo(rPrice, 2);
    expect(plan.stopPct).toBeCloseTo(rPrice / last.close, 3);
    expect(plan.r3).toBeCloseTo(last.close + 3 * rPrice, 2);
    expect(plan.r5).toBeCloseTo(last.close + 5 * rPrice, 2);
    expect(plan.altEntry).toBeGreaterThan(last.high);
    // 2,000,000 HKD at 7.8 = 256,410 USD; 0.5% = 1,282 USD of risk
    expect(plan.riskBudget).toBe(Math.round((2_000_000 / 7.8) * 0.005));
    expect(plan.shares).toBe(Math.floor(((2_000_000 / 7.8) * 0.005) / rPrice));
    expect(plan.riskAtStop).toBeCloseTo((plan.shares as number) * rPrice, -1);
    expect(plan.positionValue).toBeCloseTo((plan.shares as number) * last.close, -1);
    expect(plan.lot).toBe(1);
    expect(plan.lotTooBig).toBe(false);
    expect(p.stopPct).toBeCloseTo(plan.stopPct, 4);
    expect(p.why).toHaveLength(3);
    expect(p.why[0]?.text).toMatch(/^Top 10% on 3m/);
    expect(p.why[2]?.text).toMatch(/^Turn-up bar/);
    expect(p.score).toBeGreaterThan(40);
    expect(p.score).toBeLessThanOrEqual(100);
    // payload levels: the support map has the EMAs, AVWAP and the base low, sorted by distance, one in play
    const sources = p.levels.map((l) => l.source);
    expect(sources).toEqual(expect.arrayContaining(['ema9', 'ema21', 'ema50', 'avwap_high', 'base_low']));
    expect(p.levels.filter((l) => l.inPlay)).toHaveLength(1);
    expect(p.levels.every((l, i, a) => i === 0 || (a[i - 1]?.distPct as number) <= l.distPct)).toBe(true);
    expect(p.confluence).toBeGreaterThanOrEqual(1);
    expect(r.reasons.some((x) => x.rule === 'leaders.stop')).toBe(true);
  });

  it('the same series one day earlier (no turn-up bar yet) is a Watch', async () => {
    const bars = leaderBars();
    const r = await run({ bars, asOf: (bars[N - 2] as DailyBar).day });
    expect(r.payload.state).toBe('watch');
    expect(r.verdict).toBe('WARN');
    expect(r.payload.turnUp).toBe(false);
    expect(r.payload.plan).toBeNull();
    expect(r.payload.why[2]?.text).toMatch(/^(No turn-up bar yet|Waiting for a touch)/);
  });

  it('a close below the 50-EMA is Broken', async () => {
    const r = await run({ shape: { last: { close: 80, open: 82, low: 79.5, high: 82.5 } } });
    expect(r.payload.state).toBe('broken');
    expect(r.payload.reason).toMatch(/below the (50-EMA|base low)/);
    expect(r.payload.plan).toBeNull();
    expect(r.verdict).toBe('NA');
  });

  it('a 3.6% stop stays a Watch and says the width', async () => {
    const r = await run({ shape: { last: { low: 96.8 * (1 - 0.036) } } });
    expect(r.payload.turnUp).toBe(true);
    expect(r.payload.state).toBe('watch');
    expect(r.payload.stopPct).toBeGreaterThan(0.03);
    expect(r.payload.plan).toBeNull();
    expect(r.payload.reason).toMatch(/needs a 3\.\d% stop, above the 3% cap/);
    expect(r.payload.why[2]?.text).toMatch(/^Turn-up bar printed, but the turn-up bar needs a 3\.\d% stop/);
    expect(r.payload.flags.some((f) => f.level === 'fail' && /Stop 3\.\d% > 3% cap/.test(f.text))).toBe(true);
  });

  it('earnings 5 days out demotes to Watch and flags the blackout; 9 days out does not', async () => {
    const near = await run({ earnings: { earnings: '2026-10-14', exDividend: null } });
    expect(near.payload.state).toBe('watch');
    expect(near.payload.earningsInDays).toBe(5);
    expect(near.payload.reason).toMatch(/earnings in 5 days, inside the 7-day blackout/);
    expect(near.payload.flags).toContainEqual({ level: 'fail', text: 'Earnings in 5 d · blackout' });
    expect(near.payload.parts.penalty).toBeGreaterThanOrEqual(15);
    const far = await run({ earnings: { earnings: '2026-10-18', exDividend: null } });
    expect(far.payload.state).toBe('setup');
    expect(far.payload.earningsInDays).toBe(9);
    expect(far.payload.flags).toContainEqual({ level: 'warn', text: 'Earnings in 9 d' });
  });

  it('earnings come from the stored calendar when the scan did not look them up; unknown is flagged', async () => {
    const stored = await run({
      events: [
        {
          type: 'earnings',
          date: '2026-10-12',
          confirmed: true,
          source: 'yahoo',
          knownAt: '2026-09-01T00:00:00Z',
          details: null,
        },
      ],
    });
    expect(stored.payload.earningsInDays).toBe(3);
    expect(stored.payload.state).toBe('watch');
    const none = await run();
    expect(none.payload.earningsKnown).toBe(false);
    expect(none.payload.flags).toContainEqual({ level: 'warn', text: 'Earnings date unknown' });
    expect(none.dataQuality.missing).toContain('earnings');
    expect(none.payload.state).toBe('setup');
  });

  it('regime panic and crash guard demote every Setup to Watch, say so, and take 20 points off', async () => {
    const calm = await run();
    const panic = await run({ vol: 35 });
    expect(panic.payload.regime).toBe('panic');
    expect(panic.payload.posture).toBe('watch_only');
    expect(panic.payload.state).toBe('watch');
    expect(panic.payload.reason).toMatch(/regime panic: pullback entries are off/);
    expect(panic.payload.plan).toBeNull();
    expect(panic.payload.flags).toContainEqual({ level: 'fail', text: 'Regime panic: watch only' });
    expect(calm.payload.score - panic.payload.score).toBeGreaterThanOrEqual(20);
    const crash = await run({ vol: 45 });
    expect(crash.payload.posture).toBe('watch_only');
    expect(crash.payload.state).toBe('watch');
  });

  it('HK: shares round DOWN to the stock board lot', async () => {
    const r = await run({ market: 'HK', instrument: { providerSymbols: { stockLot: 500 } } });
    expect(r.payload.state).toBe('setup');
    const plan = r.payload.plan;
    expect(plan?.lot).toBe(500);
    expect(plan?.lotTooBig).toBe(false);
    const rPrice = plan?.r as number;
    // equity is in HKD already: 2,000,000 x 0.5% = 10,000 HKD of risk
    expect(plan?.riskBudget).toBe(10_000);
    expect(plan?.shares).toBe(Math.floor(Math.floor(10_000 / rPrice) / 500) * 500);
    expect((plan?.shares as number) % 500).toBe(0);
    expect(r.payload.flags.some((f) => f.text === 'Board lot unverified')).toBe(false);
  });

  it('HK: when one lot already risks more than the budget it shows one lot and flags the risk', async () => {
    const r = await run({ market: 'HK', instrument: { providerSymbols: { stockLot: 20_000 } } });
    const plan = r.payload.plan;
    expect(plan?.shares).toBe(20_000);
    expect(plan?.lotTooBig).toBe(true);
    const pctText = ((plan?.lotRiskPct as number) * 100).toFixed(2);
    expect(Number(pctText)).toBeGreaterThan(0.5);
    expect(r.payload.flags).toContainEqual({ level: 'warn', text: `1 lot risks ${pctText}%` });
    expect(r.payload.parts.penalty).toBeGreaterThanOrEqual(5);
  });

  it('HK without a verified stock lot falls back to the stored lot and says it is unverified', async () => {
    const r = await run({ market: 'HK', instrument: { multiplier: 100, providerSymbols: {} } });
    expect(r.payload.plan?.lot).toBe(100);
    expect(r.payload.flags).toContainEqual({ level: 'warn', text: 'Board lot unverified' });
  });

  it('equity NULL leaves shares and risk blank and everything else intact', async () => {
    const r = await run({ equity: null });
    expect(r.payload.state).toBe('setup');
    const plan = r.payload.plan;
    expect(plan).not.toBeNull();
    expect(plan?.shares).toBeNull();
    expect(plan?.riskBudget).toBeNull();
    expect(plan?.riskAtStop).toBeNull();
    expect(plan?.positionValue).toBeNull();
    expect(plan?.pctOfEquity).toBeNull();
    expect(plan?.lotRiskPct).toBeNull();
    expect(plan?.stop).toBeGreaterThan(0);
    expect(plan?.r3).toBeGreaterThan(plan?.entry as number);
    expect(r.payload.why).toHaveLength(3);
  });

  it('an equity in the other currency is converted with the stored FX rate', async () => {
    const usd = await run({ equity: 256_410.26 });
    // base HKD portfolio helper: 256,410 HKD is 32,873 USD, a tenth of the default budget
    expect(usd.payload.plan?.riskBudget).toBe(Math.round((256_410.26 / 7.8) * 0.005));
  });
});

describe('S8 leaders.pullback: where a name stops', () => {
  it('without the rank table the skill returns excluded: "no rank table"', async () => {
    const r = await run({ ranks: null });
    expect(r.payload.state).toBe('excluded');
    expect(r.payload.reason).toMatch(/^no rank table/);
    expect(r.score).toBeNull();
    expect(r.dataQuality.missing).toContain('leaders.ranks');
  });

  it('too little history, a low price or thin dollar volume are excluded at the screen with the row named', async () => {
    const short = await run({ bars: leaderBars().slice(-100) });
    expect(short.payload.reason).toBe('history: 100 bars, needs 130');
    expect(short.payload.reached).toBe('screened');
    const cheap = leaderBars();
    for (const b of cheap) {
      b.open *= 0.04;
      b.high *= 0.04;
      b.low *= 0.04;
      b.close *= 0.04;
      b.adjClose *= 0.04;
    }
    expect((await run({ bars: cheap })).payload.reason).toMatch(/^price \d+\.\d+ below the US\$5 floor/);
    const thin = leaderBars().map((b) => ({ ...b, volume: 10_000 }));
    expect((await run({ bars: thin })).payload.reason).toMatch(/^dollar volume US\$1m a day, floor US\$20m/);
    const noBar = await run({ bars: leaderBars(), asOf: '2026-10-12' });
    expect(noBar.payload.reason).toMatch(/^no bar for 2026-10-12/);
  });

  it('a name below the gain line or the rank line is not a leader', async () => {
    const flat = leaderBars();
    const slow = flat.map((b, i) => {
      const k = 1 / (1 + (i / N) * 0.1);
      return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
    });
    expect(leaderRule({ ret3m: 0.1, ret6m: 0.12 }, RANKS, defaultParams()['leaders.pullback']).reason).toMatch(
      /neither reaches \+30%/,
    );
    const weak = await run({ ranks: { rank1m: 40, rank3m: 60, rank6m: 80, screened: 500 } });
    expect(weak.payload.state).toBe('excluded');
    expect(weak.payload.reason).toBe('not a leader: ranked in the top 25% on 1 of 3 windows, needs 2');
    expect(weak.payload.reached).toBe('screened');
    expect(weak.payload.isLeader).toBe(false);
    expect(slow.length).toBe(N);
  });

  it('a leader whose base is too deep, too long, too short or still expanding is excluded with the rule', async () => {
    const deep = await run({ shape: { base: BASE_CLOSES.map((c) => 100 - (100 - c) * 7) } });
    expect(deep.payload.state).toBe('excluded');
    expect(deep.payload.reason).toMatch(/^base \d+% deep, limit 25%/);
    expect(deep.payload.reached).toBe('leaders');
    const params = defaultParams();
    params['leaders.pullback'].baseMaxLen = 10;
    expect((await run({ params })).payload.reason).toBe(`base ${LEN} days long, limit 10`);
    params['leaders.pullback'].baseMaxLen = 45;
    params['leaders.pullback'].baseMinLen = 20;
    expect((await run({ params })).payload.reason).toMatch(
      new RegExp(`^no base yet: the range high was ${LEN} days ago, a base needs 20`),
    );
    const params2 = defaultParams();
    params2['leaders.pullback'].depthMin = 0.2;
    expect((await run({ params: params2 })).payload.reason).toMatch(/^base only \d+% deep, a pullback needs 20%/);
  });

  it('a close well above the 21-EMA, still inside the base, is Extended', async () => {
    const params = defaultParams();
    params['leaders.pullback'].extendedPct = 0.03;
    const r = await run({ params, shape: { last: { open: 96.0, close: 99.6, low: 95.8, high: 99.9 } } });
    expect(r.payload.state).toBe('extended');
    expect(r.payload.reason).toMatch(/^extended: \d+% above the 21-EMA/);
    expect(r.payload.reached).toBe('consolidating');
    expect(r.payload.plan).toBeNull();
  });
});

describe('S8 leaders.pullback: stage A helpers', () => {
  it('leadersScreen gives the returns the job ranks on and the first failing row', () => {
    const p = defaultParams()['leaders.pullback'];
    const bars = leaderBars();
    const s = leadersScreen(bars, (bars[N - 1] as DailyBar).day, 'US', p);
    expect(s.eligible).toBe(true);
    expect(s.reason).toBeNull();
    const closes = bars.map((b) => b.close);
    expect(s.ret3m).toBeCloseTo((closes[N - 1] as number) / (closes[N - 1 - 63] as number) - 1, 12);
    expect(s.ret6m).toBeCloseTo((closes[N - 1] as number) / (closes[N - 1 - 126] as number) - 1, 12);
    expect(s.dollarVol20).toBeGreaterThan(20_000_000);
    expect(leadersScreen(bars.slice(0, 50), '2026-01-01', 'US', p).eligible).toBe(false);
  });

  it('the 21-EMA the skill reports matches the indicator', async () => {
    const bars = leaderBars();
    const r = await run({ bars });
    const e = ema(
      bars.map((b) => b.close),
      21,
    );
    expect(r.payload.ema21).toBeCloseTo(e[N - 1] as number, 3);
  });

  it('level sources map to the families that decide confluence', () => {
    expect(LEVEL_FAMILY.ema9).toBe(LEVEL_FAMILY.ema50);
    expect(LEVEL_FAMILY.avwap_high).toBe(LEVEL_FAMILY.avwap_low);
    expect(LEVEL_FAMILY.gap).not.toBe(LEVEL_FAMILY.swing_low);
  });
});

describe('S8 leaders.pullback: no look-ahead', () => {
  it('bars after the as-of date change nothing', async () => {
    const bars = leaderBars();
    const asOf = (bars[N - 3] as DailyBar).day;
    const clean = await run({ bars: bars.slice(0, N - 2), asOf });
    const future = bars.map((b, i) =>
      i >= N - 2 ? { ...b, open: b.open * 3, high: b.high * 3, low: b.low / 3, close: b.close * 2 } : b,
    );
    const withFuture = await run({ bars: future, asOf });
    expect(withFuture.payload).toEqual(clean.payload);
    expect(withFuture.reasons).toEqual(clean.reasons);
  });
});
