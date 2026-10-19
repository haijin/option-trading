import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params';
import type { Instrument, OptionChainSnapshot } from '../../src/core/types';
import { listLots, sellLot } from '../../src/db/lots';
import { computeMark, latestMarks, markOpenPositions } from '../../src/db/marks';
import { closeManualPosition, openManualPosition } from '../../src/db/position-ops';
import { positionMarks } from '../../src/db/schema';
import { writeBars, writeOptionChain } from '../../src/db/writers';
import { bar, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: Instrument;
const NOW = new Date('2026-03-13T22:00:00Z');
const params = defaultParams();

function flatBars(from: string, n: number, close: number) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(bar(day, close + Math.sin(i) * 1.5));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

beforeAll(async () => {
  db = await createTestDb();
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  await writeBars(db.db, aapl.id, flatBars('2025-12-01', 120, 112));
});
afterAll(async () => {
  await db.drop();
});

describe('computeMark', () => {
  const position = {
    strike: 100,
    expiry: '2026-04-17',
    openPrice: 2,
    quantity: 2,
    multiplier: 100,
    openDate: '2026-03-02',
  };
  const common = { position, asOf: '2026-03-13', spot: 112, rate: 0.04, skewBumpPer10Delta: 0.02 };

  it('prefers a fresh stored quote (real tier) and computes P&L on the full size', () => {
    const v = computeMark({ ...common, quote: { price: 1.2, delta: -0.1, ageDays: 0 }, sigmaAtm: 0.3 });
    expect(v?.tier).toBe('real');
    expect(v?.mark).toBe(1.2);
    expect(v?.unrealizedPnl).toBeCloseTo((2 - 1.2) * 100 * 2, 9);
    expect(v?.pctCaptured).toBeCloseTo(0.4, 9);
  });

  it('ignores a stale quote and falls back to the model', () => {
    const v = computeMark({ ...common, quote: { price: 1.2, delta: -0.1, ageDays: 9 }, sigmaAtm: 0.3 });
    expect(v?.tier).toBe('synthetic');
    expect(v?.mark).toBeGreaterThan(0);
  });

  it('returns null with neither a quote nor a sigma, and for a past-expiry position', () => {
    expect(computeMark({ ...common, quote: null, sigmaAtm: null })).toBeNull();
    expect(computeMark({ ...common, asOf: '2026-04-20', quote: null, sigmaAtm: 0.3 })).toBeNull();
  });
});

describe('markOpenPositions', () => {
  let positionId: number;

  it('marks from the model when there is no chain, stores one row per day and replaces it on rerun', async () => {
    positionId = await openManualPosition(db.db, {
      instrument: aapl,
      strike: 100,
      expiry: '2026-04-17',
      contracts: 2,
      price: 2,
      date: '2026-03-02',
    });
    const r1 = await markOpenPositions(db.db, { asOf: '2026-03-13', params });
    expect(r1.skipped).toEqual([]);
    expect(r1.marked).toHaveLength(1);
    expect(r1.marked[0]?.tier).toBe('synthetic');
    const r2 = await markOpenPositions(db.db, { asOf: '2026-03-13', params });
    expect(r2.marked).toHaveLength(1);
    const rows = await db.db.select().from(positionMarks).where(eq(positionMarks.positionId, positionId));
    expect(rows).toHaveLength(1);
  });

  it('uses a stored quote for the exact contract once one exists', async () => {
    const snap: OptionChainSnapshot = {
      snapshotDate: '2026-03-13',
      underlyingPrice: 112,
      source: 'yahoo',
      tier: 'real',
      quotes: [
        {
          expiry: '2026-04-17',
          strike: 100,
          right: 'P',
          bid: 0.9,
          ask: 1.1,
          last: 1.0,
          volume: 10,
          openInterest: 100,
          iv: 0.3,
          delta: -0.12,
          gamma: null,
          theta: null,
          vega: null,
          multiplier: 100,
        },
      ],
    };
    await writeOptionChain(db.db, aapl.id, snap, NOW);
    const r = await markOpenPositions(db.db, { asOf: '2026-03-13', params });
    expect(r.marked[0]?.tier).toBe('real');
    expect(r.marked[0]?.mark).toBeCloseTo(1.0, 9);
    expect(r.marked[0]?.alerts.map((a) => a.code)).toContain('profit50');
    const latest = await latestMarks(db.db, [positionId]);
    expect(latest.get(positionId)?.mark).toBeCloseTo(1.0, 9);
    expect(latest.get(positionId)?.alertCodes).toContain('profit50');
  });

  it('reports a skip, not a made-up number, when the underlying has no bars', async () => {
    const msft = await seedInstrument(db.db, 'US', 'MSFT');
    await openManualPosition(db.db, {
      instrument: msft,
      strike: 400,
      expiry: '2026-04-17',
      contracts: 1,
      price: 5,
      date: '2026-03-02',
    });
    const r = await markOpenPositions(db.db, { asOf: '2026-03-13', params });
    expect(r.skipped.map((s) => s.symbol)).toContain('US:MSFT');
  });
});

describe('the wheel', () => {
  it('an assigned put leaves a stock lot at the assignment close, and selling it books the second leg', async () => {
    const nvda = await seedInstrument(db.db, 'US', 'NVDA');
    const id = await openManualPosition(db.db, {
      instrument: nvda,
      strike: 100,
      expiry: '2026-03-20',
      contracts: 2,
      price: 3,
      date: '2026-03-02',
    });
    const res = await closeManualPosition(db.db, {
      id,
      kind: 'assigned',
      underlyingClose: 94,
      date: '2026-03-20',
      today: '2026-03-20',
    });
    // premium 3 - intrinsic 6 = -3 per share on 200 shares
    expect(res.realizedPnl).toBeCloseTo(-600, 6);
    const lots = await listLots(db.db, { status: 'open' });
    const lot = lots.find((l) => l.positionId === id);
    expect(lot?.shares).toBe(200);
    expect(lot?.costBasis).toBe(94);
    // strike less premium: what the shares effectively cost
    expect(lot?.effectiveCost).toBeCloseTo(97, 6);
    const sold = await sellLot(db.db, lot?.id as number, { price: 99, date: '2026-04-01', fees: 2 });
    // (99 - 94) x 200 - 2
    expect(sold.realizedPnl).toBeCloseTo(998, 6);
    await expect(sellLot(db.db, lot?.id as number, { price: 99, date: '2026-04-02' })).rejects.toThrow(/already sold/);
  });

  it('an expired or bought-back put leaves no lot', async () => {
    const amd = await seedInstrument(db.db, 'US', 'AMD');
    const id = await openManualPosition(db.db, {
      instrument: amd,
      strike: 150,
      expiry: '2026-03-20',
      contracts: 1,
      price: 2,
      date: '2026-03-02',
    });
    await closeManualPosition(db.db, { id, kind: 'expired', today: '2026-03-20' });
    expect((await listLots(db.db)).some((l) => l.instrument.symbol === 'AMD')).toBe(false);
  });
});
