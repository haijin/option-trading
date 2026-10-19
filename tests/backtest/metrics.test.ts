import { describe, expect, it } from 'vitest';
import {
  attributionByRule,
  equityMetrics,
  mulberry32,
  overfitWarning,
  perStockCards,
  type TradeRecord,
  tradeMetrics,
} from '../../src/backtest/metrics';

function trade(over: Partial<TradeRecord> & Pick<TradeRecord, 'pnl'>): TradeRecord {
  return {
    instrumentId: 1,
    entryDate: '2024-01-01',
    exitDate: '2024-02-01',
    roc: over.pnl / 5000,
    annualizedRoc: 0,
    daysHeld: 30,
    exitReason: 'expired',
    tier: 'real',
    collateral: 5000,
    maxAdverseExcursion: null,
    ...over,
  };
}

const FOUR: TradeRecord[] = [
  trade({ pnl: 100, roc: 0.02, maxAdverseExcursion: 50 }),
  trade({ pnl: 50, roc: 0.01, maxAdverseExcursion: 100 }),
  trade({ pnl: -200, roc: -0.04, daysHeld: 20, exitReason: 'assigned', tier: 'synthetic', maxAdverseExcursion: 300 }),
  trade({ pnl: 50, roc: 0.01, daysHeld: 10, tier: 'proxy' }),
];

function hasNaN(x: unknown): boolean {
  if (typeof x === 'number') return !Number.isFinite(x);
  if (Array.isArray(x)) return x.some(hasNaN);
  if (x !== null && typeof x === 'object') return Object.values(x).some(hasNaN);
  return false;
}

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe('tradeMetrics', () => {
  const m = tradeMetrics(FOUR);

  it('computes hand-checked pooled statistics', () => {
    expect(m.n).toBe(4);
    expect(m.winRate).toBeCloseTo(0.75, 12);
    expect(m.avgPnl).toBeCloseTo(0, 12);
    expect(m.medianPnl).toBe(50); // sorted -200, 50, 50, 100
    expect(m.avgRoc).toBeCloseTo(0, 12);
    // capital-time = 5000 * (30 + 30 + 20 + 10) / 365; sum pnl = 0
    expect(m.annualizedRocOnCollateral).toBeCloseTo(0, 12);
    expect(m.profitFactor).toBeCloseTo(1, 12); // 200 gross win / 200 gross loss
    expect(m.avgDaysHeld).toBeCloseTo(22.5, 12);
    expect(m.exitReasonMix).toEqual({ expired: 3, assigned: 1 });
    expect(m.assignmentRate).toBeCloseTo(0.25, 12);
    expect(m.tStat).toBeCloseTo(0, 12);
  });

  it('annualised ROC on collateral is pnl per capital-year', () => {
    const one = tradeMetrics([trade({ pnl: 100, daysHeld: 73, collateral: 10_000 })]);
    expect(one.annualizedRocOnCollateral).toBeCloseTo(100 / ((10_000 * 73) / 365), 12); // 0.05
  });

  it('mae distribution ignores nulls and interpolates percentiles', () => {
    // values 50, 100, 300: p50 = 100, p90 at position 1.8 = 100 + 0.8 * 200 = 260
    expect(m.mae).toEqual({ p50: 100, p90: 260, max: 300 });
    expect(tradeMetrics([trade({ pnl: 1 })]).mae).toBeNull();
  });

  it('worst5 is the lowest pnl first and capped at 5', () => {
    expect(m.worst5.map((t) => t.pnl)).toEqual([-200, 50, 50, 100]);
    const many = Array.from({ length: 8 }, (_, i) => trade({ pnl: i - 4 }));
    expect(tradeMetrics(many).worst5.map((t) => t.pnl)).toEqual([-4, -3, -2, -1, 0]);
  });

  it('profit factor is null without losses; tStat null for n<2 or zero dispersion', () => {
    expect(tradeMetrics([trade({ pnl: 10 }), trade({ pnl: 10 })]).profitFactor).toBeNull();
    expect(tradeMetrics([trade({ pnl: 10 }), trade({ pnl: 10 })]).tStat).toBeNull();
    expect(tradeMetrics([trade({ pnl: 10 })]).tStat).toBeNull();
  });

  it('tStat matches mean / (sd / sqrt n)', () => {
    // pnl 10, 20, 30: mean 20, sd 10, t = 20 / (10 / sqrt 3) = 2 sqrt 3
    const r = tradeMetrics([trade({ pnl: 10 }), trade({ pnl: 20 }), trade({ pnl: 30 })]);
    expect(r.tStat).toBeCloseTo(2 * Math.sqrt(3), 10);
  });

  it('splits by tier', () => {
    expect(m.byTier.real?.n).toBe(2);
    expect(m.byTier.real?.winRate).toBe(1);
    expect(m.byTier.synthetic?.n).toBe(1);
    expect(m.byTier.synthetic?.winRate).toBe(0);
    expect(m.byTier.synthetic?.tStat).toBeNull();
    expect(m.byTier.proxy?.avgPnl).toBe(50);
    expect(Object.keys(m.byTier).sort()).toEqual(['proxy', 'real', 'synthetic']);
  });

  it('bootstrap CIs are reproducible per seed and bracket sensible values', () => {
    const a = tradeMetrics(FOUR, { seed: 1, resamples: 500 });
    const b = tradeMetrics(FOUR, { seed: 1, resamples: 500 });
    expect(a.winRateCI).toEqual(b.winRateCI);
    expect(a.avgRocCI).toEqual(b.avgRocCI);
    const ci = a.winRateCI!;
    expect(ci.lo).toBeLessThanOrEqual(ci.hi);
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(a.avgRocCI!.lo).toBeLessThan(0.02);
    expect(a.avgRocCI!.hi).toBeGreaterThan(-0.02);
  });

  it('bootstrap of identical trades collapses to a point', () => {
    const r = tradeMetrics([trade({ pnl: 10, roc: 0.002 }), trade({ pnl: 10, roc: 0.002 })], { resamples: 50 });
    expect(r.winRateCI).toEqual({ lo: 1, hi: 1 });
    expect(r.avgRocCI!.lo).toBeCloseTo(0.002, 12);
    expect(r.avgRocCI!.hi).toBeCloseTo(0.002, 12);
  });

  it('handles no trades without NaN', () => {
    const r = tradeMetrics([]);
    expect(r.n).toBe(0);
    expect(r.winRate).toBeNull();
    expect(r.winRateCI).toBeNull();
    expect(r.avgRocCI).toBeNull();
    expect(r.worst5).toEqual([]);
    expect(r.byTier).toEqual({});
    expect(hasNaN(r)).toBe(false);
  });

  it('never leaks NaN on typical input', () => {
    expect(hasNaN(m)).toBe(false);
  });
});

describe('equityMetrics', () => {
  const pt = (day: string, equity: number, deployedPct = 0.5) => ({ day, equity, deployedPct });

  it('computes cagr, total return and monthly returns on a 365-day span', () => {
    const r = equityMetrics([pt('2023-01-01', 100), pt('2023-07-01', 110), pt('2024-01-01', 121)]);
    expect(r.totalReturn).toBeCloseTo(0.21, 12);
    expect(r.cagr).toBeCloseTo(0.21, 12);
    expect(r.maxDrawdown).toBe(0);
    expect(r.maxDrawdownDays).toBe(0);
    expect(r.calmar).toBeNull();
    expect(r.sharpe).toBeNull(); // both returns 10 %: zero dispersion
    expect(r.sortino).toBeNull(); // no downside
    expect(r.avgDeployedPct).toBeCloseTo(0.5, 12);
    expect(r.monthlyReturns.map((x) => x.month)).toEqual(['2023-01', '2023-07', '2024-01']);
    expect(r.monthlyReturns[0]!.ret).toBeCloseTo(0, 12);
    expect(r.monthlyReturns[1]!.ret).toBeCloseTo(0.1, 12);
    expect(r.monthlyReturns[2]!.ret).toBeCloseTo(0.1, 12);
  });

  it('volatility, sharpe and sortino on returns +10 % and -10 %', () => {
    const curve = [pt('2024-01-01', 100), pt('2024-01-02', 110), pt('2024-01-03', 99)];
    const flat = equityMetrics(curve);
    // sample sd of [0.1, -0.1] = sqrt(0.02) ; annual vol = sd * sqrt(252)
    expect(flat.annualVol).toBeCloseTo(Math.sqrt(0.02) * Math.sqrt(252), 10);
    expect(flat.sharpe).toBeCloseTo(0, 12);
    expect(flat.maxDrawdown).toBeCloseTo(-0.1, 12);
    expect(flat.maxDrawdownDays).toBe(1); // peak 01-02, never recovered, ends 01-03
    expect(flat.calmar).not.toBeNull();

    // rf 25.2 % annual = 0.001 per day: excess mean -0.001
    const rf = equityMetrics(curve, { riskFree: 0.252 });
    expect(rf.sharpe).toBeCloseTo((-0.001 / Math.sqrt(0.02)) * Math.sqrt(252), 10); // -0.11225
    // downside deviation vs 0 = sqrt((0 + 0.01) / 2)
    expect(rf.sortino).toBeCloseTo((-0.001 / Math.sqrt(0.005)) * Math.sqrt(252), 10); // -0.2245
  });

  it('measures drawdown duration peak to recovery', () => {
    const r = equityMetrics([
      pt('2024-01-01', 100),
      pt('2024-01-10', 120), // peak
      pt('2024-01-20', 90),
      pt('2024-02-09', 120), // recovers (>= peak) 30 days after the peak
      pt('2024-02-10', 130),
    ]);
    expect(r.maxDrawdown).toBeCloseTo(-0.25, 12);
    expect(r.maxDrawdownDays).toBe(30);
    expect(r.calmar).toBeCloseTo(r.cagr! / 0.25, 10);
  });

  it('splits monthly returns at month boundaries', () => {
    const r = equityMetrics([
      pt('2024-01-30', 100),
      pt('2024-01-31', 102),
      pt('2024-02-01', 103.02),
      pt('2024-02-29', 102),
    ]);
    expect(r.monthlyReturns).toHaveLength(2);
    expect(r.monthlyReturns[0]!.month).toBe('2024-01');
    expect(r.monthlyReturns[0]!.ret).toBeCloseTo(0.02, 12);
    expect(r.monthlyReturns[1]!.ret).toBeCloseTo(0, 12); // 102 / 102 - 1
  });

  it('returns nulls, never NaN, for degenerate curves', () => {
    for (const curve of [[], [pt('2024-01-01', 100)], [pt('2024-01-01', 0), pt('2024-01-02', 5)]]) {
      const r = equityMetrics(curve);
      expect(r.cagr).toBeNull();
      expect(r.sharpe).toBeNull();
      expect(r.maxDrawdown).toBeNull();
      expect(r.totalReturn).toBeNull();
      expect(r.monthlyReturns).toEqual([]);
      expect(hasNaN(r)).toBe(false);
    }
    expect(equityMetrics([]).avgDeployedPct).toBeNull();
    expect(equityMetrics([pt('2024-01-01', 100, 0.3)]).avgDeployedPct).toBeCloseTo(0.3, 12);
  });

  it('survives a wiped-out account', () => {
    const r = equityMetrics([pt('2024-01-01', 100), pt('2024-01-02', 0), pt('2024-01-03', 0)]);
    expect(r.maxDrawdown).toBe(-1);
    expect(r.cagr).toBeNull();
    expect(hasNaN(r)).toBe(false);
  });
});

describe('perStockCards', () => {
  const trades = [
    trade({ instrumentId: 1, pnl: 100, roc: 0.02, exitDate: '2024-01-10' }),
    trade({ instrumentId: 1, pnl: -300, roc: -0.06, exitDate: '2024-02-10', tier: 'synthetic' }),
    trade({ instrumentId: 1, pnl: 50, roc: 0.01, exitDate: '2024-03-10', tier: 'synthetic' }),
    trade({ instrumentId: 2, pnl: 20, roc: 0.004, exitDate: '2024-01-05', tier: 'proxy' }),
  ];

  it('builds one card per instrument with drawdown on cumulative pnl', () => {
    const cards = perStockCards(trades, '2024-01-01', '2024-12-31');
    expect(Object.keys(cards).sort()).toEqual(['1', '2']);
    const c1 = cards[1]!;
    expect(c1.n).toBe(3);
    expect(c1.winRate).toBeCloseTo(2 / 3, 12);
    expect(c1.avgRoc).toBeCloseTo((0.02 - 0.06 + 0.01) / 3, 12);
    // cumulative 100, -200, -150; peak 100; worst -300; mean collateral 5000
    expect(c1.maxDD).toBeCloseTo(-0.06, 12);
    expect(c1.tierMix.real).toBeCloseTo(1 / 3, 12);
    expect(c1.tierMix.synthetic).toBeCloseTo(2 / 3, 12);
    expect(c1.tierMix.proxy).toBe(0);
    expect([c1.from, c1.to]).toEqual(['2024-01-01', '2024-12-31']);
    expect(cards[2]!.maxDD).toBe(0);
    expect(cards[2]!.tierMix).toEqual({ real: 0, proxy: 1, synthetic: 0 });
  });

  it('orders by exit date regardless of input order', () => {
    const cards = perStockCards([...trades].reverse(), 'a', 'b');
    expect(cards[1]!.maxDD).toBeCloseTo(-0.06, 12);
  });

  it('opening loss counts from a zero baseline', () => {
    const cards = perStockCards([trade({ pnl: -500, roc: -0.1 })], 'a', 'b');
    expect(cards[1]!.maxDD).toBeCloseTo(-0.1, 12);
  });

  it('is empty for no trades', () => {
    expect(perStockCards([], 'a', 'b')).toEqual({});
  });
});

describe('attributionByRule', () => {
  const withRules = (pnl: number, roc: number, rules?: Record<string, boolean>) =>
    trade({ pnl, roc, scores: rules === undefined ? undefined : { rules } });

  it('splits passed vs failed per rule', () => {
    const rows = attributionByRule([
      withRules(100, 0.02, { rsi: true, trend: true }),
      withRules(-100, -0.02, { rsi: true, trend: false }),
      withRules(40, 0.008, { rsi: false, trend: true }),
      withRules(999, 0.5), // no rules recorded: ignored
      trade({ pnl: 5, scores: { rules: 'nope' } }),
    ]);
    expect(rows.map((r) => r.rule)).toEqual(['rsi', 'trend']);
    const rsi = rows[0]!;
    expect(rsi.passed.n).toBe(2);
    expect(rsi.passed.winRate).toBe(0.5);
    expect(rsi.passed.avgRoc).toBeCloseTo(0, 12);
    expect(rsi.failed).toEqual({ n: 1, winRate: 1, avgRoc: 0.008 });
    const trend = rows[1]!;
    expect(trend.passed.n).toBe(2);
    expect(trend.passed.winRate).toBe(1);
    expect(trend.failed).toEqual({ n: 1, winRate: 0, avgRoc: -0.02 });
  });

  it('keeps one-sided rules with nulls on the empty side', () => {
    const rows = attributionByRule([withRules(10, 0.1, { only: true })]);
    expect(rows).toEqual([
      { rule: 'only', passed: { n: 1, winRate: 1, avgRoc: 0.1 }, failed: { n: 0, winRate: null, avgRoc: null } },
    ]);
  });

  it('returns [] when nothing has rules', () => {
    expect(attributionByRule([trade({ pnl: 1 })])).toEqual([]);
  });
});

describe('overfitWarning', () => {
  it('fires when OOS < 0.5 * IS and IS > 0', () => {
    expect(overfitWarning(1, 0.4)).toBe(true);
    expect(overfitWarning(1, 0.5)).toBe(false);
    expect(overfitWarning(1, 0.9)).toBe(false);
    expect(overfitWarning(1, -0.2)).toBe(true);
  });
  it('never fires when IS <= 0 or missing', () => {
    expect(overfitWarning(0, -1)).toBe(false);
    expect(overfitWarning(-1, -5)).toBe(false);
    expect(overfitWarning(null, 1)).toBe(false);
  });
  it('treats missing OOS with positive IS as a warning', () => {
    expect(overfitWarning(1, null)).toBe(true);
  });
});
