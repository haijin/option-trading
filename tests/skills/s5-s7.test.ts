import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params';
import type { GovernorSettings, OpenPosition, Reason } from '../../src/core/types';
import type { SkillResult } from '../../src/skills/contract';
import { rankComposite } from '../../src/skills/s5-rank-composite';
import { sizePosition } from '../../src/skills/s6-size-position';
import { explainNarrative } from '../../src/skills/s7-explain-narrative';
import { ctxFor, END, makeHistory, portfolio } from '../helpers/history';

const res = (
  skillId: string,
  o: {
    score?: number | null;
    verdict?: SkillResult['verdict'];
    reasons?: Reason[];
    payload?: unknown;
    tier?: 'real' | 'proxy' | 'synthetic';
  } = {},
): SkillResult => ({
  skillId,
  version: '1.0.0',
  score: o.score === undefined ? null : o.score,
  verdict: o.verdict ?? 'PASS',
  reasons: o.reasons ?? [],
  payload: o.payload ?? {},
  dataQuality: { tier: o.tier ?? 'real', missing: [] },
});

const chosen = (over: Record<string, unknown> = {}) => ({
  contractId: 'chain',
  strike: 95,
  expiry: '2026-11-20',
  dte: 42,
  bid: 2.5,
  ask: 2.6,
  mid: 2.55,
  fillPrice: 2.5,
  delta: 0.25,
  iv: 0.4,
  oi: 500,
  spreadPct: 0.04,
  credit: 250,
  collateral: 9500,
  collateralBaseCcy: 74_100,
  marginEstimate: 2000,
  rocOnMargin: 0.125,
  roc: 0.0263,
  annRoc: 0.15,
  breakeven: 92.5,
  cushionPct: 0.08,
  probItm: 0.25,
  probTouch: 0.5,
  bsProbItm: 0.27,
  expectedValue: 10,
  lossProbIv: 0.3,
  lossProbRv: 0.2,
  greeksSource: 'computed',
  ...over,
});

const warn = (rule: string, kind: 'rule' | 'data'): Reason => ({
  rule,
  value: true,
  passed: false,
  level: 'WARN',
  kind,
});
const failR = (rule: string): Reason => ({
  rule,
  value: true,
  passed: false,
  level: 'FAIL',
  kind: 'rule',
  note: 'because',
});

function priors(
  o: {
    s1?: Partial<Parameters<typeof res>[1]>;
    s2?: Partial<Parameters<typeof res>[1]>;
    s3?: Partial<Parameters<typeof res>[1]>;
    s4?: Partial<Parameters<typeof res>[1]>;
    deployCapPct?: number;
  } = {},
) {
  return new Map<string, SkillResult>([
    [
      'market.regime',
      res('market.regime', {
        verdict: 'NA',
        payload: {
          regime: 'bull_calm',
          deployCapPct: o.deployCapPct ?? 0.5,
          deltaCap: 0.3,
          indexVsSma200Pct: 0.05,
          volIndex: 15,
          usedVolIndex: true,
        },
      }),
    ],
    [
      'fundamental.gate',
      res('fundamental.gate', {
        score: 80,
        payload: {
          earningsInWindow: false,
          nextEarnings: '2026-12-15',
          skipped: [],
          fScore: 8,
          zScore: 4,
          gearing: null,
          interestCover: null,
          fcfYield: 0.05,
          netDebtEbitda: 1.2,
          evEbitZ: null,
        },
        ...o.s1,
      }),
    ],
    [
      'technical.timing',
      res('technical.timing', {
        score: 60,
        payload: {
          close: 100,
          support: 92,
          supportSource: 'sma50',
          rsi14: 40,
          ret3m: 0.03,
          indexRet3m: 0.02,
          trendState: 'up',
          sma200: 90,
        },
        ...o.s2,
      }),
    ],
    [
      'volatility.edge',
      res('volatility.edge', {
        score: 70,
        payload: {
          iv30: 0.4,
          ivRank: 55,
          ivPercentile: 60,
          rv20: 0.25,
          rv60: 0.26,
          vrpRatio: 1.6,
          tier: 'real',
          ivSource: 'chain',
          rankBasis: 'real',
        },
        ...o.s3,
      }),
    ],
    [
      'option.select',
      res('option.select', {
        payload: { chosen: chosen(), alternative: null, tier: 'real', source: 'yahoo' },
        ...o.s4,
      }),
    ],
  ]);
}

const run5 = (p: Map<string, SkillResult>, extra: Parameters<typeof ctxFor>[2] = {}) =>
  rankComposite.run(ctxFor(makeHistory(), END, { priors: p, ...extra }));

describe('S5 rank.composite', () => {
  it('composite = 0.35 F + 0.25 T + 0.20 V + 0.20 option, optionScore = clamp(annRoc/target,0,1.5) x 60 + clamp(cushion/0.10,0,1) x 40', async () => {
    const r = await run5(priors());
    // optionScore = (0.15 / 0.15) x 60 + (0.08 / 0.10) x 40 = 92
    expect(r.payload.scores).toEqual({ fundamental: 80, technical: 60, vol: 70, option: 92 });
    expect(r.payload.composite).toBeCloseTo(0.35 * 80 + 0.25 * 60 + 0.2 * 70 + 0.2 * 92, 1);
    expect(r.payload.multiplier).toBe(1);
    expect(r.verdict).toBe('PASS');
    expect(r.payload.confidence).toBeNull();
  });

  it('option score is clamped: ROC above 1.5x target and cushion above 10% max out at 90 + 40', async () => {
    const r = await run5(priors({ s4: { payload: { chosen: chosen({ annRoc: 0.9, cushionPct: 0.5 }) } } }));
    expect(r.payload.scores.option).toBe(130);
  });

  it('T11: an unscored volatility skill (rvOnly) drops out and the weights are renormalised over the rest', async () => {
    const r = await run5(priors({ s3: { score: null, verdict: 'NA', reasons: [warn('iv.unscored', 'data')] } }));
    expect(r.payload.scores.vol).toBeNull();
    const w = r.payload.weightsUsed;
    expect(Object.keys(w).sort()).toEqual(['fundamental', 'option', 'technical']);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(r.payload.composite).toBeCloseTo((0.35 * 80 + 0.25 * 60 + 0.2 * 92) / 0.8, 1);
    expect(r.reasons.some((x) => x.rule === 'rank.weightsRenormalised')).toBe(true);
  });

  it('T11: a RULE warning applies the 0.85 multiplier; DATA-quality warnings do not', async () => {
    const base = (await run5(priors())).payload.composite as number;
    const rule = await run5(priors({ s2: { reasons: [warn('trend.belowSma200', 'rule')], verdict: 'WARN' } }));
    expect(rule.payload.multiplier).toBe(0.85);
    expect(rule.payload.composite).toBeCloseTo(base * 0.85, 1);
    expect(rule.payload.ruleWarns).toEqual(['trend.belowSma200']);
    expect(rule.verdict).toBe('WARN');
    const data = await run5(
      priors({
        s1: {
          reasons: [warn('fundamentals.partialCoverage', 'data'), warn('events.earningsUnknown', 'data')],
          verdict: 'WARN',
        },
        s3: { reasons: [warn('iv.proxy', 'data')], verdict: 'WARN' },
      }),
    );
    expect(data.payload.multiplier).toBe(1);
    expect(data.payload.composite).toBeCloseTo(base, 1);
    expect(data.payload.ruleWarns).toEqual([]);
    expect(data.reasons.some((x) => x.rule === 'rank.dataWarningsNotPenalised')).toBe(true);
  });

  it('conviction adds conviction x 0.05 x 20 points after the multiplier', async () => {
    const base = (await run5(priors())).payload.composite as number;
    const r = await run5(priors(), { conviction: 5 });
    expect(r.payload.composite).toBeCloseTo(base + 5, 1);
    expect(r.payload.convictionBonus).toBeCloseTo(5, 6);
  });

  it('an upstream FAIL makes S5 FAIL with the same binding rule and the failing skill; the composite is still computed for explain', async () => {
    const r = await run5(priors({ s3: { verdict: 'FAIL', reasons: [failR('vol.noEdge')] } }));
    expect(r.verdict).toBe('FAIL');
    expect(r.payload.failedAt).toBe('volatility.edge');
    expect(r.reasons.find((x) => x.level === 'FAIL')).toMatchObject({ rule: 'vol.noEdge' });
    expect(r.payload.composite).not.toBeNull();
  });

  it('T14/S5: an open position on the name excludes it (portfolio.alreadyOpen) while the scores stay visible', async () => {
    const open: OpenPosition = {
      instrumentId: 1,
      symbol: 'AAPL',
      market: 'US',
      sector: 'Technology',
      currency: 'USD',
      strike: 90,
      multiplier: 100,
      quantity: 1,
      expiry: '2026-11-20',
    };
    const r = await run5(priors(), { portfolio: portfolio({ openPositions: [open] }) });
    expect(r.payload.excluded).toBe('alreadyOpen');
    expect(r.verdict).toBe('NA');
    expect(r.payload.composite).not.toBeNull();
    expect(r.reasons.find((x) => x.rule === 'portfolio.alreadyOpen')?.note).toContain(
      'never recommended again while open',
    );
  });

  it('earnings allowed inside the window need IV rank >= 60 (A5): otherwise FAIL events.earningsNeedsIvr', async () => {
    const p = defaultParams();
    p['fundamental.gate'].allowEarningsInWindow = true;
    const inWindow = { payload: { earningsInWindow: true, nextEarnings: '2026-10-30' } };
    const low = await run5(priors({ s1: inWindow, s3: { payload: { ivRank: 40, iv30: 0.3, tier: 'real' } } }), {
      params: p,
    });
    expect(low.verdict).toBe('FAIL');
    expect(low.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('events.earningsNeedsIvr');
    const high = await run5(priors({ s1: inWindow, s3: { payload: { ivRank: 75, iv30: 0.3, tier: 'real' } } }), {
      params: p,
    });
    expect(high.verdict).not.toBe('FAIL');
  });

  it('journal-derived backtest card when past trades on the name exist; confidence stays null without a backtest', async () => {
    const h = makeHistory({
      journal: [
        { openDate: '2026-01-05', closeDate: '2026-02-05', pnl: 300, collateral: 10_000 },
        { openDate: '2026-03-05', closeDate: '2026-04-05', pnl: -500, collateral: 10_000 },
        { openDate: '2026-05-05', closeDate: '2026-06-05', pnl: 100, collateral: 10_000 },
        { openDate: '2026-10-01', closeDate: '2026-10-20', pnl: 999, collateral: 10_000 }, // after asOf: invisible
      ],
    });
    const r = await rankComposite.run(ctxFor(h, END, { priors: priors() }));
    expect(r.payload.backtestCard).toEqual({
      n: 3,
      winRate: 2 / 3,
      avgRoc: (0.03 - 0.05 + 0.01) / 3,
      source: 'journal',
    });
    expect(r.payload.confidence).toBeNull();
  });
});

describe('S6 size.position', () => {
  const sizeCtx = (
    p: Map<string, SkillResult>,
    o: Parameters<typeof ctxFor>[2] & { maxCollateralPct?: number } = {},
  ) => {
    const ctx = ctxFor(makeHistory(), END, { priors: p, ...o });
    if (o.maxCollateralPct !== undefined) ctx.maxCollateralPct = o.maxCollateralPct;
    return ctx;
  };

  it('contracts = floor(min(5% equity, remaining regime cap) / notional in base currency)', async () => {
    const r = await sizePosition.run(sizeCtx(priors(), { portfolio: portfolio({ equity: 10_000_000 }) }));
    // 5% x 10M = 500,000; one contract = 74,100 HKD; floor(6.74) = 6
    expect(r.payload.contracts).toBe(6);
    expect(r.payload.collateralBaseCcy).toBeCloseTo(6 * 74_100, 2);
    expect(r.payload.pctOfEquity).toBeCloseTo((6 * 74_100) / 10_000_000, 6);
    expect(r.payload.capsHit).toEqual([]);
    expect(r.verdict).toBe('PASS');
  });

  it('is sized on NOTIONAL: broker margin never enters', async () => {
    const tinyMargin = priors({ s4: { payload: { chosen: chosen({ marginEstimate: 1, rocOnMargin: 250 }) } } });
    const r = await sizePosition.run(sizeCtx(tinyMargin, { portfolio: portfolio({ equity: 10_000_000 }) }));
    expect(r.payload.contracts).toBe(6);
  });

  it('a single contract above the per-name budget gives 0 contracts and names the cap (perNameCap)', async () => {
    const r = await sizePosition.run(sizeCtx(priors(), { portfolio: portfolio({ equity: 1_000_000 }) }));
    expect(r.payload.contracts).toBe(0);
    expect(r.payload.capsHit).toContain('perNameCap');
    expect(r.reasons.find((x) => x.rule === 'size.perNameCap')?.level).toBe('FAIL');
    expect(r.verdict).toBe('WARN');
  });

  it('the regime deployment cap is reduced by open collateral and by names already sized in this scan', async () => {
    const open: OpenPosition = {
      instrumentId: 9,
      symbol: 'XOM',
      market: 'US',
      sector: 'Energy',
      currency: 'USD',
      strike: 100,
      multiplier: 100,
      quantity: 10,
      expiry: '2026-11-20',
    };
    // equity 10M, bull_calm 50% = 5M; open = 100 x 100 x 10 x 7.8 = 780,000; committed 4,000,000 -> 220,000 left -> 2 contracts
    const r = await sizePosition.run(
      sizeCtx(priors(), {
        portfolio: portfolio({ equity: 10_000_000, openPositions: [open], committedBase: 4_000_000 }),
      }),
    );
    expect(r.payload.regimeRemainingBase).toBeCloseTo(5_000_000 - 780_000 - 4_000_000, 2);
    expect(r.payload.contracts).toBe(2);
    expect(r.payload.capsHit).toEqual([]);
    const none = await sizePosition.run(
      sizeCtx(priors(), {
        portfolio: portfolio({ equity: 10_000_000, openPositions: [open], committedBase: 4_300_000 }),
      }),
    );
    expect(none.payload.contracts).toBe(0);
    expect(none.payload.capsHit).toContain('regimeCap');
  });

  it("open collateral in the other market does not eat this market's bucket", async () => {
    const hk: OpenPosition = {
      instrumentId: 8,
      symbol: '0005',
      market: 'HK',
      sector: 'Financial Services',
      currency: 'HKD',
      strike: 100,
      multiplier: 400,
      quantity: 100,
      expiry: '2026-11-27',
    };
    const r = await sizePosition.run(
      sizeCtx(priors(), { portfolio: portfolio({ equity: 10_000_000, openPositions: [hk] }) }),
    );
    expect(r.payload.regimeRemainingBase).toBeCloseTo(5_000_000, 2);
  });

  it('close below SMA200 halves the size; earnings allowed inside the window halves it again', async () => {
    const below = priors({ s2: { reasons: [warn('trend.belowSma200', 'rule')], verdict: 'WARN' } });
    const r = await sizePosition.run(sizeCtx(below, { portfolio: portfolio({ equity: 10_000_000 }) }));
    expect(r.payload.sizeFactor).toBe(0.5);
    expect(r.payload.contracts).toBe(3); // floor(250,000 / 74,100)
    const p = defaultParams();
    p['fundamental.gate'].allowEarningsInWindow = true;
    const both = priors({
      s2: { reasons: [warn('trend.belowSma200', 'rule')], verdict: 'WARN' },
      s1: { payload: { earningsInWindow: true, nextEarnings: '2026-10-30' } },
    });
    const r2 = await sizePosition.run(sizeCtx(both, { portfolio: portfolio({ equity: 10_000_000 }), params: p }));
    expect(r2.payload.sizeFactor).toBe(0.25);
    expect(r2.payload.contracts).toBe(1);
  });

  it('sector limit: three open puts in the sector (or committed in this scan) block a fourth', async () => {
    const mk = (id: number): OpenPosition => ({
      instrumentId: id,
      symbol: `T${id}`,
      market: 'US',
      sector: 'Technology',
      currency: 'USD',
      strike: 10,
      multiplier: 100,
      quantity: 1,
      expiry: '2026-11-20',
    });
    const r = await sizePosition.run(
      sizeCtx(priors(), { portfolio: portfolio({ equity: 10_000_000, openPositions: [mk(11), mk(12), mk(13)] }) }),
    );
    expect(r.payload.contracts).toBe(0);
    expect(r.payload.capsHit).toContain('sectorCap');
    const committed = await sizePosition.run(
      sizeCtx(priors(), { portfolio: portfolio({ equity: 10_000_000, committedBySector: { Technology: 3 } }) }),
    );
    expect(committed.payload.contracts).toBe(0);
  });

  it('a per-name collateral override replaces the 5% default', async () => {
    const r = await sizePosition.run(
      sizeCtx(priors(), { portfolio: portfolio({ equity: 10_000_000 }), maxCollateralPct: 0.1 }),
    );
    expect(r.payload.contracts).toBe(13); // floor(1,000,000 / 74,100)
  });

  it('refuses without equity, and cannot size without an FX rate or a contract', async () => {
    const noEq = await sizePosition.run(sizeCtx(priors(), { portfolio: portfolio({ equity: null }) }));
    expect(noEq.verdict).toBe('FAIL');
    expect(noEq.reasons[0]?.rule).toBe('size.noEquity');
    const noFx = await sizePosition.run(
      sizeCtx(priors({ s4: { payload: { chosen: chosen({ collateralBaseCcy: null }) } } })),
    );
    expect(noFx.payload.contracts).toBe(0);
    expect(noFx.reasons[0]?.rule).toBe('size.noFx');
    const none = await sizePosition.run(sizeCtx(priors({ s4: { payload: { chosen: null } } })));
    expect(none.payload.contracts).toBe(0);
    expect(none.reasons[0]?.rule).toBe('size.noContract');
  });
});

describe('S7 explain.narrative', () => {
  const withAll = () => {
    const p = priors();
    p.set(
      'rank.composite',
      res('rank.composite', {
        score: 75.4,
        payload: {
          composite: 75.4,
          confidence: null,
          backtestCard: null,
          excluded: null,
          failedAt: null,
          ruleWarns: [],
          scores: {},
        },
      }),
    );
    p.set(
      'size.position',
      res('size.position', {
        payload: { contracts: 6, collateral: 57_000, collateralBaseCcy: 444_600, pctOfEquity: 0.0445, capsHit: [] },
      }),
    );
    return p;
  };

  it('builds the headline and sections from the payloads only, with the numbers of the chosen contract', async () => {
    const r = await explainNarrative.run(ctxFor(makeHistory(), END, { priors: withAll() }));
    const { headline, text } = r.payload;
    expect(headline).toContain('sell 2026-11 Put 95.00');
    expect(headline).toContain('delta 0.25, 42 DTE');
    expect(headline).toContain('US$2.50 x 100 = US$250');
    expect(headline).toContain('collateral US$9,500');
    expect(headline).toContain('15.0% annualised');
    expect(headline).toContain('breakeven 92.50 (-8.0%)');
    for (const section of ['Quality:', 'Timing:', 'Vol:', 'Events:', 'Regime:', 'Size:', 'Data:'])
      expect(text).toContain(section);
    expect(text).toContain('results on 2026-12-15 fall AFTER expiry');
    expect(text).toContain('6 contract(s)');
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('a name with no contract says so and names the binding rule', async () => {
    const p = priors({ s3: { verdict: 'FAIL', reasons: [failR('vol.noEdge')] }, s4: { payload: { chosen: null } } });
    const r = await explainNarrative.run(ctxFor(makeHistory(), END, { priors: p }));
    expect(r.payload.headline).toContain('no put to sell');
    expect(r.payload.headline).toContain('Binding rule: vol.noEdge');
  });

  it('the merged reasons list tags every reason with its skill', async () => {
    const r = await explainNarrative.run(
      ctxFor(makeHistory(), END, { priors: priors({ s3: { reasons: [warn('iv.proxy', 'data')] } }) }),
    );
    expect(r.payload.reasons.find((x) => x.rule === 'iv.proxy')?.skillId).toBe('volatility.edge');
  });
});

describe('S6 drawdown governor (T3)', () => {
  const ledgerOf = (o: { closes?: { day: string; pnl: number }[]; marks?: { day: string; pnl: number }[] }) => ({
    positions: [
      ...(o.closes ?? []).map((c, i) => ({
        positionId: i + 1,
        currency: 'HKD' as const,
        openDate: '2026-01-05',
        closeDate: c.day,
        realizedPnl: c.pnl,
      })),
      ...(o.marks?.length
        ? [{ positionId: 99, currency: 'HKD' as const, openDate: '2026-09-01', closeDate: null, realizedPnl: null }]
        : []),
    ],
    marks: (o.marks ?? []).map((m) => ({ positionId: 99, day: m.day, unrealizedPnl: m.pnl })),
  });
  const run6 = (ledger: ReturnType<typeof ledgerOf>, governor?: GovernorSettings) =>
    sizePosition.run(
      ctxFor(makeHistory({ ledger }), END, {
        priors: priors(),
        portfolio: portfolio({ equity: 10_000_000, ...(governor ? { governor } : {}) }),
      }),
    );
  const bigLoss = ledgerOf({ closes: [{ day: '2026-10-09', pnl: -600_000 }] });

  it('defaults (no settings at all, or every rule off) leave the contracts unchanged and emit no governor reason', async () => {
    const none = await run6(bigLoss);
    expect(none.payload.contracts).toBe(6);
    expect(none.payload.governor).toMatchObject({ multiplier: 1, tier: null, halt: null, dayPnl: -600_000 });
    const off = await run6(bigLoss, { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: [] });
    expect(off.payload.contracts).toBe(6);
    expect(off.reasons.map((r) => r.rule)).not.toContain('size.drawdownTier');
    expect(off.reasons.map((r) => r.rule)).not.toContain('size.dailyLossHalt');
  });

  it('a day loss at the limit halts: FAIL size.dailyLossHalt, 0 contracts', async () => {
    const r = await run6(bigLoss, { dailyLossLimit: 600_000, consecutiveLossHalt: null, degearTiers: [] });
    expect(r.verdict).toBe('FAIL');
    expect(r.payload.contracts).toBe(0);
    expect(r.reasons.find((x) => x.rule === 'size.dailyLossHalt')).toMatchObject({ level: 'FAIL', value: 'dailyLoss' });
    expect(r.payload.governor?.halt?.kind).toBe('dailyLoss');
    const under = await run6(bigLoss, { dailyLossLimit: 600_001, consecutiveLossHalt: null, degearTiers: [] });
    expect(under.payload.contracts).toBe(6);
  });

  it('a losing streak at the halt count halts too (value consecutiveLosses)', async () => {
    const streak = ledgerOf({
      closes: [
        { day: '2026-09-01', pnl: 100 },
        { day: '2026-09-10', pnl: -10 },
        { day: '2026-09-20', pnl: -10 },
      ],
    });
    const r = await run6(streak, { dailyLossLimit: null, consecutiveLossHalt: 2, degearTiers: [] });
    expect(r.reasons.find((x) => x.rule === 'size.dailyLossHalt')).toMatchObject({
      level: 'FAIL',
      value: 'consecutiveLosses',
    });
    expect(r.payload.contracts).toBe(0);
    const ok = await run6(streak, { dailyLossLimit: null, consecutiveLossHalt: 3, degearTiers: [] });
    expect(ok.payload.contracts).toBe(6);
  });

  it('the deepest de-gear tier reached multiplies the size and is a rule WARN size.drawdownTier', async () => {
    // peak 400,000 then a 1,000,000 loss: cumulative -600,000, drawdown 1,000,000 = 10% of equity
    const dd = ledgerOf({
      closes: [
        { day: '2026-08-01', pnl: 400_000 },
        { day: '2026-09-15', pnl: -1_000_000 },
      ],
    });
    const tiers = [
      { drawdownPct: 5, multiplier: 0.75 },
      { drawdownPct: 10, multiplier: 0.5 },
    ];
    const r = await run6(dd, { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: tiers });
    expect(r.payload.governor?.drawdownPct).toBe(10);
    expect(r.payload.sizeFactor).toBe(0.5);
    expect(r.payload.contracts).toBe(3);
    expect(r.reasons.find((x) => x.rule === 'size.drawdownTier')).toMatchObject({ level: 'WARN', kind: 'rule' });
    expect(r.verdict).toBe('PASS');
  });

  it('a tier with multiplier 0 stops new puts and names drawdownTier as the cap hit', async () => {
    const dd = ledgerOf({
      closes: [
        { day: '2026-08-01', pnl: 100 },
        { day: '2026-09-15', pnl: -2_000_000 },
      ],
    });
    const r = await run6(dd, {
      dailyLossLimit: null,
      consecutiveLossHalt: null,
      degearTiers: [{ drawdownPct: 15, multiplier: 0 }],
    });
    expect(r.payload.contracts).toBe(0);
    expect(r.payload.capsHit).toEqual(['drawdownTier']);
  });

  it("marks count: the change in an open put's mark against its previous mark is today's P&L", async () => {
    const marked = ledgerOf({
      marks: [
        { day: '2026-10-08', pnl: 50_000 },
        { day: '2026-10-09', pnl: -200_000 },
      ],
    });
    const r = await run6(marked, { dailyLossLimit: 250_000, consecutiveLossHalt: null, degearTiers: [] });
    expect(r.payload.governor?.dayPnl).toBe(-250_000);
    expect(r.payload.contracts).toBe(0);
  });
});
