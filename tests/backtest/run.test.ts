import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EntryCandidate, EntrySource } from '../../src/backtest/engine';
import { entryCredit, syntheticPut } from '../../src/backtest/pricer';
import { assertCalendarRange, deepMerge, runBacktest } from '../../src/backtest/run';
import { isTradingDay } from '../../src/core/calendar';
import { diffDays } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type { Instrument } from '../../src/core/types';
import { addToWatchlist, setSettings } from '../../src/db/repos';
import { backtestRuns, backtestTrades } from '../../src/db/schema';
import { writeBars } from '../../src/db/writers';
import { targetExpiries } from '../../src/skills/s4-option-select';
import { rng, tradingDaysEnding } from '../helpers/history';
import { bar, indexInstrument, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: Instrument;
let closes: Map<string, number>;

/** A put 6% below the close, nearest expiry in the window, one name at a time. */
function scripted(instrumentId: number): EntrySource {
  return {
    async candidates(day, view) {
      if (view.openPositions.length > 0) return [];
      const spot = closes.get(day);
      const expiry = targetExpiries('US', day, 30, 45).at(-1);
      if (!spot || !expiry) return [];
      const strike = Math.round(spot * 0.94);
      const dte = diffDays(expiry, day);
      const p = syntheticPut({ spot, strike, dte, rate: 0.04 }, 0.28, 0.02);
      const c: EntryCandidate = {
        instrumentId,
        strike,
        expiry,
        fillPrice: entryCredit(p.mid, { slippage: 0.1, modelRisk: 0.05 }),
        delta: p.delta,
        iv: p.sigma,
        contracts: 2,
        score: 1,
        tier: 'synthetic',
        rules: { 'test.rule': Number(day.slice(-1)) % 2 === 0 },
      };
      return [c];
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  await setSettings(db.db, { baseCurrency: 'USD' });
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  await addToWatchlist(db.db, aapl.id);
  const days = tradingDaysEnding('US', '2023-12-29', 520);
  const r = rng(11);
  let x = 150;
  closes = new Map();
  const bars = days.map((day) => {
    x *= 1 + (r() - 0.48) * 0.025;
    closes.set(day, Math.round(x * 100) / 100);
    return bar(day, closes.get(day) as number);
  });
  await writeBars(db.db, aapl.id, bars);
  const spy = await indexInstrument(db.db, 'US', 'SPY');
  await writeBars(
    db.db,
    spy.id,
    days.map((day, i) => bar(day, 400 + i * 0.2)),
  );
});
afterAll(async () => {
  await db.drop();
});

const range = { from: '2022-03-01', to: '2023-12-29' };

describe('runBacktest', () => {
  it('stores a finished run with trades, equity curve, metrics, benchmarks, sensitivity and caveats', async () => {
    const id = await runBacktest(
      db.db,
      { ...range, tierPolicy: 'real_then_synthetic', initialCapital: 500_000, name: 'scripted' },
      { source: scripted(aapl.id) },
    );
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('done');
    expect(Number(run?.progress)).toBe(100);
    expect(run?.request).toMatchObject({ from: '2022-03-01', tierPolicy: 'real_then_synthetic' });
    const trades = await db.db.select().from(backtestTrades).where(eq(backtestTrades.backtestRunId, id));
    expect(trades.length).toBeGreaterThan(5);
    expect(
      trades.every((t) =>
        ['take_profit', 'dte_exit', 'stop_loss', 'expired_otm', 'assigned', 'end_of_test'].includes(t.exitReason),
      ),
    ).toBe(true);
    expect(trades.every((t) => t.exitDate > t.entryDate)).toBe(true);

    // biome-ignore lint/suspicious/noExplicitAny: the metrics column is untyped JSON
    const m = run?.metrics as any;
    expect(m.trades.n).toBe(trades.length);
    expect(m.tierMix.synthetic).toBe(trades.length);
    expect(m.benchmarks.naive.trades.n).toBeGreaterThan(0);
    expect(Object.keys(m.benchmarks.index)).toContain('SPY');
    expect(m.sensitivity.points).toHaveLength(3);
    expect(m.caveats.join(' ')).toContain('Survivorship');
    expect(Object.keys(m.cards)).toContain(String(aapl.id));
    // equity ends at capital plus realised P&L (cash interest included, no open positions at the end)
    const curve = run?.equityCurve as [string, number, number][];
    expect(curve.length).toBeGreaterThan(300);
    expect(curve[curve.length - 1]?.[2]).toBe(0);
    const pnl = trades.reduce((s, t) => s + Number(t.pnl), 0);
    expect((curve[curve.length - 1]?.[1] as number) - 500_000).toBeGreaterThan(pnl - 1); // interest only adds
  }, 120_000);

  it('runs the real pipeline without error and records a done run even when nothing passes the rules', async () => {
    const id = await runBacktest(db.db, {
      ...range,
      tierPolicy: 'synthetic_only',
      initialCapital: 500_000,
      benchmarks: false,
      sensitivity: false,
    });
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('done');
    // biome-ignore lint/suspicious/noExplicitAny: untyped JSON column
    expect((run as { metrics: any }).metrics.scanDays).toBeGreaterThan(50);
  }, 180_000);

  it('can be cancelled between days and says so', async () => {
    let calls = 0;
    const id = await runBacktest(
      db.db,
      { ...range, tierPolicy: 'real_then_synthetic', initialCapital: 500_000 },
      { source: scripted(aapl.id), shouldCancel: () => ++calls > 20 },
    );
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('cancelled');
    expect(await db.db.select().from(backtestTrades).where(eq(backtestTrades.backtestRunId, id))).toHaveLength(0);
  });

  it('real_only drops synthetic entries', async () => {
    const id = await runBacktest(
      db.db,
      { ...range, tierPolicy: 'real_only', initialCapital: 500_000, benchmarks: false, sensitivity: false },
      { source: scripted(aapl.id) },
    );
    // biome-ignore lint/suspicious/noExplicitAny: untyped JSON column
    const m = (await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id)))[0]?.metrics as any;
    expect(m.trades.n).toBe(0);
    expect(m.skipped.tier_policy).toBeGreaterThan(0);
  }, 120_000);

  it('walk-forward reports windows with out-of-sample results only', async () => {
    const id = await runBacktest(
      db.db,
      {
        from: '2022-02-01',
        to: '2023-12-29',
        tierPolicy: 'real_then_synthetic',
        initialCapital: 500_000,
        benchmarks: false,
        sensitivity: false,
        walkForward: {
          trainMonths: 12,
          testMonths: 6,
          grid: [{ 'size.position': { maxPerNamePct: 0.03 } }, { 'size.position': { maxPerNamePct: 0.05 } }],
        },
      },
      { source: scripted(aapl.id) },
    );
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    // biome-ignore lint/suspicious/noExplicitAny: untyped JSON column
    const wf = run?.walkForward as any;
    expect(wf.windows.length).toBeGreaterThanOrEqual(1);
    expect(wf.windows[0].testFrom > wf.windows[0].trainTo).toBe(true);
    expect(typeof wf.aggregate.overfitting).toBe('boolean');
  }, 180_000);

  it('refuses dates outside the exchange calendar and an empty watchlist', async () => {
    await expect(
      runBacktest(db.db, { from: '2008-01-02', to: '2012-01-02', tierPolicy: 'synthetic_only' }),
    ).rejects.toThrow(/calendar/);
    expect(() => assertCalendarRange('2022-01-01', '2021-01-01')).toThrow(/before/);
    await expect(
      runBacktest(db.db, { ...range, tierPolicy: 'synthetic_only', symbols: [{ market: 'US', symbol: 'NOPE' }] }),
    ).rejects.toThrow(/no watchlist names/);
  });
});

describe('deepMerge', () => {
  it('overrides nested keys without losing siblings', () => {
    const p = defaultParams();
    const merged = deepMerge(p, { 'option.select': { deltaMax: 0.2 } });
    expect(merged['option.select'].deltaMax).toBe(0.2);
    expect(merged['option.select'].deltaMin).toBe(p['option.select'].deltaMin);
    expect(p['option.select'].deltaMax).not.toBe(0.2); // the base is not mutated
  });
});

describe('a trading day sanity check for the fixture', () => {
  it('uses real trading days', () => {
    expect(isTradingDay('US', '2023-12-29')).toBe(true);
  });
});
