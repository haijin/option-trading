import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Instrument } from '../../src/core/types';
import { skillRuns } from '../../src/db/schema';
import * as writersModule from '../../src/db/writers';
import {
  DATA_WRITERS,
  ensureOptionContracts,
  type StatementInput,
  writeBars,
  writeCalibration,
  writeCorporateEvents,
  writeFundamentals,
  writeFxRates,
  writeIvDaily,
  writeIvHistory,
  writeOptionChain,
} from '../../src/db/writers';
import { bar, indexInstrument, seedInstrument, seedSkillRun, skillRunDates } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: Instrument;
let msft: Instrument;
let tencent: Instrument;
const NOW = new Date('2026-03-01T00:00:00Z');

/** Early run (before any change) and late run (at or after the change) for the three names. */
async function seedRuns(): Promise<void> {
  await db.db.delete(skillRuns);
  for (const i of [aapl, msft, tencent]) {
    await seedSkillRun(db.db, i.id, '2026-01-05');
    await seedSkillRun(db.db, i.id, '2026-02-10');
  }
}

beforeAll(async () => {
  db = await createTestDb();
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  msft = await seedInstrument(db.db, 'US', 'MSFT');
  tencent = await seedInstrument(db.db, 'HK', '0700');
});
afterAll(async () => {
  await db.drop();
});
beforeEach(seedRuns);

const statement = (periodEnd: string, over: Partial<StatementInput> = {}): StatementInput => ({
  periodEnd,
  periodType: 'annual',
  currency: 'USD',
  revenue: 1000,
  grossProfit: 400,
  operatingIncome: 200,
  ebit: 210,
  ebitda: 250,
  interestExpense: 10,
  netIncome: 150,
  epsDiluted: 1.5,
  sharesDiluted: 100,
  totalAssets: 2000,
  currentAssets: 800,
  currentLiabilities: 500,
  totalLiabilities: 900,
  longTermDebt: 300,
  totalDebt: 350,
  cash: 200,
  retainedEarnings: 600,
  totalEquity: 1100,
  cfo: 220,
  capex: -50,
  fcf: 170,
  dividendsPaid: -40,
  buybacks: -20,
  source: 'yahoo',
  reportedAtActual: null,
  ...over,
});

describe('T5: every data writer is registered and invalidates cached skill runs', () => {
  it('DATA_WRITERS lists exactly the write* exports of writers.ts', () => {
    const exported = Object.keys(writersModule).filter((k) => k.startsWith('write'));
    expect(exported.sort()).toEqual([...DATA_WRITERS].sort());
  });

  /** One contract per writer: after the call, cache rows with as_of >= the changed date are gone, earlier ones stay. */
  const CONTRACTS: Record<(typeof DATA_WRITERS)[number], () => Promise<void>> = {
    writeBars: async () => {
      await writeBars(db.db, aapl.id, [bar('2026-01-20', 100), bar('2026-01-21', 101)]);
    },
    writeFundamentals: async () => {
      // annual period_end 2025-09-30 -> estimated reported_at = 2025-11-29, first seen 2026-03-01 -> clamp keeps the estimate
      // which is before 2026-01-05, so use a statement whose estimate lands between the two cached dates.
      await writeFundamentals(db.db, aapl.id, 'US', [statement('2025-11-20')], NOW); // 2025-11-20 + 60d = 2026-01-19
    },
    writeCorporateEvents: async () => {
      await writeCorporateEvents(
        db.db,
        aapl.id,
        [
          {
            type: 'earnings',
            date: '2026-04-30',
            confirmed: true,
            source: 'manual',
            knownAt: new Date('2026-01-20T00:00:00Z'),
          },
        ],
        NOW,
      );
    },
    writeFxRates: async () => {
      await writeFxRates(db.db, [{ day: '2026-01-20', pair: 'USDHKD', rate: 7.8, source: 'yahoo' }]);
    },
    writeOptionChain: async () => {
      await writeOptionChain(
        db.db,
        aapl.id,
        {
          snapshotDate: '2026-01-20',
          underlyingPrice: 100,
          source: 'csv',
          tier: 'real',
          quotes: [
            {
              expiry: '2026-02-20',
              strike: 90,
              right: 'P',
              bid: 1,
              ask: 1.1,
              last: 1.05,
              volume: 10,
              openInterest: 100,
              iv: 0.3,
              delta: null,
              gamma: null,
              theta: null,
              vega: null,
              multiplier: 100,
            },
          ],
        },
        NOW,
      );
    },
    writeCalibration: async () => {
      const ids = await ensureOptionContracts(db.db, aapl.id, [{ strike: 90, expiry: '2026-02-20', multiplier: 100 }]);
      await writeCalibration(db.db, aapl.id, [
        {
          contractId: ids.get('P|90|2026-02-20') as number,
          day: '2026-01-20',
          realPrice: 1,
          syntheticPrice: 1.2,
          sigmaUsed: 0.3,
          spotUsed: 100,
          deltaBucket: '10-20',
          realSource: 'csv',
          ivRvRatio: 1.1,
        },
      ]);
    },
    writeIvDaily: async () => {
      await writeIvDaily(db.db, aapl.id, { day: '2026-01-20', iv30: 0.3, tier: 'real' });
    },
    writeIvHistory: async () => {
      await writeIvHistory(db.db, aapl.id, [
        { day: '2026-01-20', iv30: 0.3, tier: 'real' },
        { day: '2026-01-21', iv30: 0.31, tier: 'real' },
      ]);
    },
  };

  it.each(DATA_WRITERS)(
    '%s deletes skill_runs at or after the earliest changed date and keeps earlier ones',
    async (name) => {
      await CONTRACTS[name]();
      expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05']);
    },
  );

  it('per-instrument writers leave other instruments alone', async () => {
    await writeBars(db.db, aapl.id, [bar('2026-01-20', 100)]);
    expect(await skillRunDates(db.db, msft.id)).toEqual(['2026-01-05', '2026-02-10']);
    expect(await skillRunDates(db.db, tencent.id)).toEqual(['2026-01-05', '2026-02-10']);
  });

  it('FX writes invalidate every instrument (collateral in base currency changes)', async () => {
    await writeFxRates(db.db, [{ day: '2026-01-20', pair: 'USDHKD', rate: 7.81, source: 'yahoo' }]);
    for (const i of [aapl, msft, tencent]) expect(await skillRunDates(db.db, i.id)).toEqual(['2026-01-05']);
  });

  it('index bars (SPY) invalidate the whole US market but not HK', async () => {
    const spy = await indexInstrument(db.db, 'US', 'SPY');
    await writeBars(db.db, spy.id, [bar('2026-01-20', 500)]);
    expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05']);
    expect(await skillRunDates(db.db, msft.id)).toEqual(['2026-01-05']);
    expect(await skillRunDates(db.db, tencent.id)).toEqual(['2026-01-05', '2026-02-10']);
  });

  it('re-writing identical bars changes nothing and keeps the cache', async () => {
    await writeBars(db.db, aapl.id, [bar('2026-01-20', 100), bar('2026-01-21', 101)]);
    await seedRuns();
    const r = await writeBars(db.db, aapl.id, [bar('2026-01-20', 100), bar('2026-01-21', 101)]);
    expect(r).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, earliestChanged: null, invalidated: 0 });
    expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05', '2026-02-10']);
  });

  it('float32 noise in the adjusted close is not a restatement and keeps the cache', async () => {
    await writeBars(db.db, aapl.id, [bar('2026-01-20', 100, 'yahoo', { adjClose: 30.917486 })]);
    await seedRuns();
    // the same adjusted close as Yahoo returns it on a later request: the 6th decimal differs (relative 2e-7)
    const r = await writeBars(db.db, aapl.id, [bar('2026-01-20', 100, 'yahoo', { adjClose: 30.91748046875 })]);
    expect(r).toMatchObject({ updated: 0, unchanged: 1, earliestChanged: null, invalidated: 0 });
    expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05', '2026-02-10']);
  });

  it('a real adjustment of 0.1 percent is still a restatement', async () => {
    await writeBars(db.db, aapl.id, [bar('2026-01-20', 100, 'yahoo', { adjClose: 100 })]);
    await seedRuns();
    const r = await writeBars(db.db, aapl.id, [bar('2026-01-20', 100, 'yahoo', { adjClose: 99.9 })]);
    expect(r).toMatchObject({ updated: 1, unchanged: 0, earliestChanged: '2026-01-20' });
    expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05']);
  });

  it('restated bars invalidate from the EARLIEST changed bar, not from today', async () => {
    const bars = [bar('2026-01-08', 100), bar('2026-01-20', 100), bar('2026-02-02', 100)];
    await writeBars(db.db, aapl.id, bars);
    await seedRuns();
    // a dividend restates adjusted closes for history: the first two bars change, the last does not
    const restated = [
      bar('2026-01-08', 100, 'yahoo', { adjClose: 98 }),
      bar('2026-01-20', 100, 'yahoo', { adjClose: 98 }),
      bar('2026-02-02', 100),
    ];
    const r = await writeBars(db.db, aapl.id, restated);
    expect(r).toMatchObject({ updated: 2, unchanged: 1, earliestChanged: '2026-01-08' });
    expect(await skillRunDates(db.db, aapl.id)).toEqual(['2026-01-05']);
  });
});

describe('writeFundamentals keeps first_seen_at and clamps reported_at (T2 persistence)', () => {
  it('first ingest stores first_seen_at = now and clamps an estimate that lies in the future', async () => {
    // period_end 2026-02-15 annual: estimate 2026-04-16 is after "now" (2026-03-01) -> reported_at = first_seen_at = now
    await writeFundamentals(db.db, msft.id, 'US', [statement('2026-02-15')], NOW);
    const { fundamentalStatements } = await import('../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.db
      .select()
      .from(fundamentalStatements)
      .where(eq(fundamentalStatements.instrumentId, msft.id));
    expect(row?.reportedAt.toISOString()).toBe(NOW.toISOString());
    expect(row?.reportedAtEstimated).toBe(true);
    expect(row?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
  });

  it('a later ingest never moves first_seen_at and keeps reported_at stable', async () => {
    const later = new Date('2026-06-01T00:00:00Z');
    await writeFundamentals(db.db, msft.id, 'US', [statement('2026-02-15')], later);
    const { fundamentalStatements } = await import('../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.db
      .select()
      .from(fundamentalStatements)
      .where(eq(fundamentalStatements.instrumentId, msft.id));
    expect(row?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(row?.reportedAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe('no code path bypasses the writers', () => {
  it('no file outside writers.ts mutates a data table directly', () => {
    const tables = [
      'priceBars',
      'fundamentalStatements',
      'corporateEvents',
      'fxRates',
      'optionQuotes',
      'optionContracts',
      'pricingCalibration',
      'ivDaily',
    ];
    const re = new RegExp(`\\.(insert|update|delete)\\(\\s*(schema\\.)?(${tables.join('|')})\\b`);
    const hits: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && e.name !== 'writers.ts' && re.test(readFileSync(p, 'utf8')))
          hits.push(p.pathname);
      }
    };
    walk(new URL('../../src/', import.meta.url));
    expect(hits).toEqual([]);
  });
});
