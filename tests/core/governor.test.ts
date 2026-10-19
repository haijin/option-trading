import { describe, expect, it } from 'vitest';
import {
  governorDecision,
  NO_GOVERNOR,
  normaliseTiers,
  type PnlSummary,
  summarisePnl,
  tierCrossed,
  tierReached,
} from '../../src/core/governor';
import type { Currency, LedgerMark, LedgerPosition, PnlLedger } from '../../src/core/types';

const fx = (c: Currency): number | null => (c === 'HKD' ? 1 : c === 'USD' ? 7.8 : null);
const pos = (over: Partial<LedgerPosition> & { positionId: number }): LedgerPosition => ({
  currency: 'HKD',
  openDate: '2026-01-05',
  closeDate: null,
  realizedPnl: null,
  ...over,
});
const mark = (positionId: number, day: string, unrealizedPnl: number): LedgerMark => ({
  positionId,
  day,
  unrealizedPnl,
});

describe('summarisePnl', () => {
  it('an empty ledger is flat: no P&L, no drawdown, no streak', () => {
    const s = summarisePnl({ positions: [], marks: [] }, '2026-03-13', 1_000_000, fx);
    expect(s).toMatchObject({ dayPnl: 0, cumulative: 0, peak: 0, drawdown: 0, drawdownPct: 0, consecutiveLosses: 0 });
  });

  it('day P&L is the closes booked today plus the change in the marks of the open puts, in base currency', () => {
    const ledger: PnlLedger = {
      positions: [
        pos({ positionId: 1, closeDate: '2026-03-13', realizedPnl: -3_000 }),
        pos({ positionId: 2, currency: 'USD' }),
      ],
      marks: [mark(2, '2026-03-12', 200), mark(2, '2026-03-13', -100)],
    };
    const s = summarisePnl(ledger, '2026-03-13', 1_000_000, fx);
    expect(s.realisedToday).toBe(-3_000);
    expect(s.markedToday).toBeCloseTo(-300 * 7.8, 6);
    expect(s.dayPnl).toBeCloseTo(-3_000 - 2_340, 6);
    expect(s.skippedCurrencies).toEqual([]);
  });

  it('a put first marked today counts its whole unrealised P&L as today; a put closed today adds no mark change', () => {
    const ledger: PnlLedger = {
      positions: [pos({ positionId: 1 }), pos({ positionId: 2, closeDate: '2026-03-13', realizedPnl: 500 })],
      marks: [mark(1, '2026-03-13', -400), mark(2, '2026-03-12', 100), mark(2, '2026-03-13', 900)],
    };
    const s = summarisePnl(ledger, '2026-03-13', 1_000_000, fx);
    expect(s.markedToday).toBe(-400);
    expect(s.realisedToday).toBe(500);
  });

  it('drawdown is peak-to-now of the cumulative curve (closes to date plus the latest open marks), as % of equity', () => {
    const ledger: PnlLedger = {
      positions: [
        pos({ positionId: 1, closeDate: '2026-02-02', realizedPnl: 10_000 }),
        pos({ positionId: 2, closeDate: '2026-02-20', realizedPnl: 5_000 }),
        pos({ positionId: 3, openDate: '2026-03-01' }),
      ],
      marks: [mark(3, '2026-03-05', 1_000), mark(3, '2026-03-13', -7_000)],
    };
    const s = summarisePnl(ledger, '2026-03-13', 100_000, fx);
    // curve: 10,000 -> 15,000 -> 16,000 (peak) -> 8,000
    expect(s.peak).toBe(16_000);
    expect(s.cumulative).toBe(8_000);
    expect(s.drawdown).toBe(8_000);
    expect(s.drawdownPct).toBe(8);
    // on 2026-03-05 the curve was at its peak: no drawdown then
    expect(summarisePnl(ledger, '2026-03-05', 100_000, fx).drawdown).toBe(0);
  });

  it('is bounded by asOf: a close or a mark after the day does not exist yet', () => {
    const ledger: PnlLedger = {
      positions: [pos({ positionId: 1, closeDate: '2026-03-20', realizedPnl: -9_000 })],
      marks: [mark(1, '2026-03-13', -100), mark(1, '2026-03-19', -8_000)],
    };
    const s = summarisePnl(ledger, '2026-03-13', 100_000, fx);
    expect(s.realisedToday).toBe(0);
    expect(s.cumulative).toBe(-100);
    expect(s.consecutiveLosses).toBe(0);
  });

  it('counts consecutive losing closes from the latest close back; a win breaks the streak', () => {
    const closes = (pnls: number[]): PnlLedger => ({
      positions: pnls.map((p, i) =>
        pos({
          positionId: i + 1,
          openDate: '2026-01-01',
          closeDate: `2026-02-${String(i + 1).padStart(2, '0')}`,
          realizedPnl: p,
        }),
      ),
      marks: [],
    });
    expect(summarisePnl(closes([100, -1, -2, -3]), '2026-03-13', null, fx).consecutiveLosses).toBe(3);
    expect(summarisePnl(closes([-1, -2, 50]), '2026-03-13', null, fx).consecutiveLosses).toBe(0);
    expect(summarisePnl(closes([-1, -2, 50, -4]), '2026-03-13', null, fx).consecutiveLosses).toBe(1);
  });

  it('a currency without an FX rate is skipped and named; without equity the drawdown percent is null', () => {
    const ledger: PnlLedger = {
      positions: [pos({ positionId: 1, currency: 'SGD', closeDate: '2026-03-13', realizedPnl: -1_000 })],
      marks: [],
    };
    const s = summarisePnl(ledger, '2026-03-13', null, fx);
    expect(s.skippedCurrencies).toEqual(['SGD']);
    expect(s.realisedToday).toBe(0);
    expect(s.drawdownPct).toBeNull();
  });
});

describe('tiers and the decision', () => {
  const summary = (over: Partial<PnlSummary>): PnlSummary => ({
    realisedToday: 0,
    markedToday: 0,
    dayPnl: 0,
    cumulative: 0,
    peak: 0,
    drawdown: 0,
    drawdownPct: 0,
    consecutiveLosses: 0,
    skippedCurrencies: [],
    ...over,
  });
  const tiers = [
    { drawdownPct: 10, multiplier: 0.5 },
    { drawdownPct: 5, multiplier: 0.75 },
    { drawdownPct: 20, multiplier: 0 },
  ];

  it('normalises tiers: shallowest first, nonsense dropped', () => {
    expect(normaliseTiers([...tiers, { drawdownPct: -1, multiplier: 0.5 }, { drawdownPct: 3, multiplier: 2 }])).toEqual(
      [
        { drawdownPct: 5, multiplier: 0.75 },
        { drawdownPct: 10, multiplier: 0.5 },
        { drawdownPct: 20, multiplier: 0 },
      ],
    );
  });

  it('the deepest tier reached applies, from exactly its threshold', () => {
    expect(tierReached(tiers, 4.9)).toBeNull();
    expect(tierReached(tiers, 5)).toEqual({ drawdownPct: 5, multiplier: 0.75 });
    expect(tierReached(tiers, 12)).toEqual({ drawdownPct: 10, multiplier: 0.5 });
    expect(tierReached(tiers, 25)).toEqual({ drawdownPct: 20, multiplier: 0 });
    expect(tierReached(tiers, null)).toBeNull();
  });

  it('defaults leave sizing unchanged: multiplier 1, no halt, whatever the P&L', () => {
    const d = governorDecision(summary({ dayPnl: -1e9, drawdownPct: 99, consecutiveLosses: 50 }), NO_GOVERNOR);
    expect(d).toEqual({ multiplier: 1, tier: null, halt: null });
    expect(governorDecision(summary({}), undefined)).toEqual({ multiplier: 1, tier: null, halt: null });
  });

  it('halts on the daily loss limit (at the limit, not above it) and on the loss streak; the daily loss wins', () => {
    const s = { dailyLossLimit: 10_000, consecutiveLossHalt: 3, degearTiers: [] };
    expect(governorDecision(summary({ dayPnl: -9_999 }), s).halt).toBeNull();
    expect(governorDecision(summary({ dayPnl: -10_000 }), s).halt?.kind).toBe('dailyLoss');
    expect(governorDecision(summary({ consecutiveLosses: 3 }), s).halt?.kind).toBe('consecutiveLosses');
    expect(governorDecision(summary({ consecutiveLosses: 2 }), s).halt).toBeNull();
    expect(governorDecision(summary({ dayPnl: -20_000, consecutiveLosses: 5 }), s).halt?.kind).toBe('dailyLoss');
  });

  it('applies the tier multiplier', () => {
    const d = governorDecision(summary({ drawdownPct: 11 }), { ...NO_GOVERNOR, degearTiers: tiers });
    expect(d.multiplier).toBe(0.5);
    expect(d.tier).toEqual({ drawdownPct: 10, multiplier: 0.5 });
  });

  it('tierCrossed fires only when today sits in a deeper tier than the previous day', () => {
    expect(tierCrossed(tiers, summary({ drawdownPct: 4 }), summary({ drawdownPct: 6 }))?.drawdownPct).toBe(5);
    expect(tierCrossed(tiers, null, summary({ drawdownPct: 6 }))?.drawdownPct).toBe(5);
    expect(tierCrossed(tiers, summary({ drawdownPct: 6 }), summary({ drawdownPct: 7 }))).toBeNull();
    expect(tierCrossed(tiers, summary({ drawdownPct: 6 }), summary({ drawdownPct: 12 }))?.drawdownPct).toBe(10);
    expect(tierCrossed(tiers, summary({ drawdownPct: 12 }), summary({ drawdownPct: 6 }))).toBeNull();
    expect(tierCrossed(tiers, summary({ drawdownPct: 12 }), summary({ drawdownPct: 1 }))).toBeNull();
  });
});
