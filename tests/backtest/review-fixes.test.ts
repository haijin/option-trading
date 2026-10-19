/** Regression tests for the defects found by the independent review of Phase 3 and 4 (DECISIONS.md, 2026-10-12). */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EntryCandidate, EntrySource, Underlying } from '../../src/backtest/engine';
import { entryCredit, syntheticPut } from '../../src/backtest/pricer';
import { deepMerge, holdEquity, queueBacktest, runQueuedBacktest } from '../../src/backtest/run';
import { diffDays } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type { Instrument } from '../../src/core/types';
import { sellLot } from '../../src/db/lots';
import { addToWatchlist, setSettings } from '../../src/db/repos';
import { backtestRuns, backtestTrades, stockLots } from '../../src/db/schema';
import { writeBars } from '../../src/db/writers';
import { dateInMarketTz } from '../../src/jobs/jobs';
import { targetExpiries } from '../../src/skills/s4-option-select';
import { rng, tradingDaysEnding } from '../helpers/history';
import { bar, indexInstrument, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: Instrument;
let closes: Map<string, number>;

function scripted(instrumentId: number): EntrySource {
  return {
    async candidates(day, view) {
      if (view.openPositions.length > 0) return [];
      const spot = closes.get(day);
      const expiry = targetExpiries('US', day, 30, 45).at(-1);
      if (!spot || !expiry) return [];
      const strike = Math.round(spot * 0.94);
      const p = syntheticPut({ spot, strike, dte: diffDays(expiry, day), rate: 0.04 }, 0.28, 0.02);
      const c: EntryCandidate = {
        instrumentId,
        strike,
        expiry,
        fillPrice: entryCredit(p.mid, { slippage: 0.1, modelRisk: 0.05 }),
        delta: p.delta,
        iv: p.sigma,
        contracts: 1,
        score: 1,
        tier: 'synthetic',
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
  const days = tradingDaysEnding('US', '2023-12-29', 400);
  const r = rng(9);
  let x = 150;
  closes = new Map();
  await writeBars(
    db.db,
    aapl.id,
    days.map((d) => {
      x *= 1 + (r() - 0.48) * 0.02;
      closes.set(d, Math.round(x * 100) / 100);
      return bar(d, closes.get(d) as number);
    }),
  );
  const spy = await indexInstrument(db.db, 'US', 'SPY');
  await writeBars(
    db.db,
    spy.id,
    days.map((d, i) => bar(d, 400 + i * 0.2)),
  );
});
afterAll(async () => {
  await db.drop();
});

describe('a queued run starts at most once', () => {
  it('running the same queued id twice (a redelivered job) does not duplicate its trades', async () => {
    const id = await queueBacktest(db.db, {
      from: '2023-03-01',
      to: '2023-12-29',
      tierPolicy: 'synthetic_only',
      benchmarks: false,
      sensitivity: false,
    });
    await runQueuedBacktest(db.db, id, { source: scripted(aapl.id) });
    const first = await db.db.select().from(backtestTrades).where(eq(backtestTrades.backtestRunId, id));
    expect(first.length).toBeGreaterThan(3);
    await runQueuedBacktest(db.db, id, { source: scripted(aapl.id) }); // redelivery
    const second = await db.db.select().from(backtestTrades).where(eq(backtestTrades.backtestRunId, id));
    expect(second).toHaveLength(first.length);
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('done');
  }, 120_000);

  it('a cancelled-before-start run is not started', async () => {
    const id = await queueBacktest(db.db, { from: '2023-03-01', to: '2023-12-29', tierPolicy: 'synthetic_only' });
    await db.db.update(backtestRuns).set({ status: 'cancelled' }).where(eq(backtestRuns.id, id));
    await runQueuedBacktest(db.db, id, { source: scripted(aapl.id) });
    expect(await db.db.select().from(backtestTrades).where(eq(backtestTrades.backtestRunId, id))).toHaveLength(0);
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('cancelled');
  });

  it('a queued run that no longer validates is marked failed, not left queued', async () => {
    const id = await queueBacktest(db.db, { from: '2023-03-01', to: '2023-12-29', tierPolicy: 'synthetic_only' });
    await db.db
      .update(backtestRuns)
      .set({
        request: {
          from: '2023-03-01',
          to: '2023-12-29',
          tierPolicy: 'synthetic_only',
          symbols: [{ market: 'US', symbol: 'GONE' }],
        },
      })
      .where(eq(backtestRuns.id, id));
    await expect(runQueuedBacktest(db.db, id)).rejects.toThrow(/no watchlist names/);
    const [run] = await db.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/no watchlist names/);
  });
});

describe('the buy-and-hold benchmark', () => {
  it('buys on the first test day, so the curve starts at the capital even when history is longer', () => {
    // bars begin long before the test window and the price doubles before it starts
    const bars = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10);
      const c = i < 20 ? 50 + i * 2.5 : 100;
      return { day: d, close: c, adjClose: c, low: c };
    });
    const u: Underlying = {
      instrumentId: 1,
      symbol: 'X',
      market: 'US',
      currency: 'USD',
      sector: null,
      multiplier: 100,
      divYield: 0,
      bars,
    };
    const testDays = bars.slice(20).map((b) => b.day);
    const curve = holdEquity([u], testDays, 1_000_000, () => 1);
    expect(curve[0]?.equity).toBeCloseTo(1_000_000, 6);
    expect(curve[curve.length - 1]?.equity).toBeCloseTo(1_000_000, 6); // flat price inside the window: no gain from before it
  });
});

describe('deepMerge', () => {
  it('ignores prototype-chain keys from a JSON body', () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "option.select": {"deltaMax": 0.2}}');
    const merged = deepMerge(defaultParams(), evil) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged['option.select'] as { deltaMax: number }).deltaMax).toBe(0.2);
  });
});

describe('selling a lot', () => {
  it('two simultaneous sales: exactly one succeeds', async () => {
    const [lot] = await db.db
      .insert(stockLots)
      .values({ instrumentId: aapl.id, shares: 100, costBasis: '100', openDate: '2023-06-01' })
      .returning({ id: stockLots.id });
    const id = (lot as { id: number }).id;
    const results = await Promise.allSettled([
      sellLot(db.db, id, { price: 110, date: '2023-07-01' }),
      sellLot(db.db, id, { price: 120, date: '2023-07-02' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('market dates for the scheduled mark jobs', () => {
  it('each market uses its own calendar date', () => {
    const t = new Date('2026-03-17T22:30:00Z'); // 06:30 on the 18th in Hong Kong, 18:30 on the 17th in New York
    expect(dateInMarketTz(t, 'HK')).toBe('2026-03-18');
    expect(dateInMarketTz(t, 'US')).toBe('2026-03-17');
  });
});
