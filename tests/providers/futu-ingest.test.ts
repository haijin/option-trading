/**
 * The ingest pipeline with an OpenD source present: HK bars come from OpenD first (Yahoo when it fails), the HK chain
 * is fetched out to the strategy's own DTE window, and OpenD's IV history backfills iv_daily without touching the
 * app's own rows. The source is a fake; Yahoo answers from the recorded fixtures.
 */
import { access, readFile } from 'node:fs/promises';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIR } from '../../src/cli/context';
import type { ISODate } from '../../src/core/dates';
import type { DailyBar, Instrument, OptionChainSnapshot } from '../../src/core/types';
import { findInstrument, upsertInstrument } from '../../src/db/repos';
import { ivDaily, optionQuotes, priceBars } from '../../src/db/schema';
import { writeIvDaily } from '../../src/db/writers';
import type { FutuIvPoint, FutuStaticInfo } from '../../src/providers/futu';
import { createReplayFetch } from '../../src/providers/http-replay';
import { type IngestDeps, type IngestItem, type IngestOptions, runIngest } from '../../src/providers/ingest';
import { ProviderError, YahooClient } from '../../src/providers/yahoo/client';
import { cliHarness, HTTP_BASE, RECORDED_NOW } from '../helpers/cli';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;

interface FakeCalls {
  bars: [string, ISODate, ISODate][];
  iv: [string, ISODate, ISODate][];
  chain: [string, number, number][];
}

function fakeFutu(opts: { barsFail?: boolean } = {}) {
  const calls: FakeCalls = { bars: [], iv: [], chain: [] };
  const bar = (day: ISODate, close: number): DailyBar => ({
    day,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    adjClose: close * 0.98,
    volume: 1000,
    source: 'futu',
  });
  const futu: NonNullable<IngestDeps['futu']> = {
    async dailyBars(inst, from, to) {
      calls.bars.push([inst.symbol, from, to]);
      if (opts.barsFail) throw new ProviderError('futu', inst.symbol, 'no answer from OpenD', 'unreachable');
      return [bar('2026-10-08', 411.4), bar('2026-10-09', 424.8)];
    },
    async ivHistory(inst, from, to) {
      calls.iv.push([inst.symbol, from, to]);
      const points: FutuIvPoint[] = [
        { day: '2026-10-07', iv: 0.2936, hv: 0.2882, underlyingPrice: 420.6 },
        { day: '2026-10-08', iv: 0.3166, hv: 0.2954, underlyingPrice: 411.4 },
        { day: '2026-10-09', iv: 0.2962, hv: 0.3179, underlyingPrice: 424.8 },
      ];
      return points.filter((p) => p.day >= from && p.day <= to);
    },
    async putChain(inst: Instrument, o): Promise<OptionChainSnapshot> {
      calls.chain.push([inst.symbol, o.minDte, o.maxDte]);
      return {
        snapshotDate: '2026-10-09',
        underlyingPrice: 424.8,
        source: 'futu',
        tier: 'real',
        quotes: [
          {
            expiry: '2026-11-27',
            strike: 400,
            right: 'P',
            bid: 8.1,
            ask: 8.4,
            last: 8.2,
            volume: 120,
            openInterest: 900,
            iv: 0.31,
            delta: -0.28,
            gamma: null,
            theta: null,
            vega: null,
            multiplier: inst.multiplier,
          },
        ],
      };
    },
    async staticInfo(insts) {
      const rows: FutuStaticInfo[] = insts.map((i) => ({
        security: { market: 1, code: i.symbol.padStart(5, '0') },
        name: i.symbol === '0700' ? 'TENCENT' : 'HSBC HOLDINGS',
        lotSize: i.symbol === '0700' ? 100 : 400,
        secType: 3,
        listTime: '2004-06-16',
        delisting: false,
      }));
      return rows;
    },
  };
  return { futu, calls };
}

async function ingest(futu: IngestDeps['futu'], opts: IngestOptions): Promise<IngestItem[]> {
  const fetch = createReplayFetch([HTTP_BASE]);
  const summary = await runIngest(
    {
      db: db.db,
      client: new YahooClient({ fetch }),
      futu,
      fetch,
      now: RECORDED_NOW,
      dataDir: DEFAULT_DATA_DIR,
      readFile: (p) => readFile(p, 'utf8'),
      fileExists: (p) =>
        access(p).then(
          () => true,
          () => false,
        ),
      log: () => {},
    },
    opts,
  );
  return summary.items;
}

beforeAll(async () => {
  db = await createTestDb();
  const h = cliHarness(db.url);
  for (const a of [
    ['settings', 'set', 'equity', '2000000', '--base', 'HKD'],
    ['watchlist', 'add', '0700', 'HK'],
    ['watchlist', 'add', '0005', 'HK'],
  ]) {
    expect((await h.run(a)).code).toBe(0);
  }
});
afterAll(async () => {
  await db.drop();
});

describe('ingest with OpenD present', () => {
  it('bars: HK names come from OpenD with source futu and the raw/adjusted closes kept apart', async () => {
    const { futu, calls } = fakeFutu();
    const items = await ingest(futu, { steps: ['bars'], only: ['0700'] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ step: 'bars', status: 'ok' });
    expect(items[0]?.detail).toMatch(/^futu OpenD: 2 bars to 2026-10-09, 2 new/);
    expect(calls.bars).toEqual([['0700', '2016-10-09', '2026-10-10']]); // ten years back, up to "today"
    const tencent = (await findInstrument(db.db, 'HK', '0700')) as Instrument;
    const rows = await db.db
      .select({ d: priceBars.day, c: priceBars.close, a: priceBars.adjClose, s: priceBars.source })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, tencent.id))
      .orderBy(asc(priceBars.day));
    expect(rows.map((r) => [r.d, Number(r.c), Number(r.a), r.s])).toEqual([
      ['2026-10-08', 411.4, 403.172, 'futu'],
      ['2026-10-09', 424.8, 416.304, 'futu'],
    ]);
  });

  it('bars: when OpenD fails the name falls back to Yahoo and the detail says both', async () => {
    const { futu } = fakeFutu({ barsFail: true });
    const items = await ingest(futu, { steps: ['bars'], only: ['0005'] });
    expect(items[0]).toMatchObject({ step: 'bars', status: 'ok' });
    expect(items[0]?.detail).toMatch(/^futu failed \(.*no answer from OpenD.*\); yahoo: \d+ bars to 2026-10-09/);
    const hsbc = (await findInstrument(db.db, 'HK', '0005')) as Instrument;
    const [last] = await db.db
      .select({ s: priceBars.source })
      .from(priceBars)
      .where(and(eq(priceBars.instrumentId, hsbc.id), eq(priceBars.day, '2026-10-09')));
    expect(last?.s).toBe('yahoo');
  });

  it('profile: OpenD static info is reported next to the Yahoo profile and never changes the multiplier', async () => {
    const { futu } = fakeFutu();
    const items = await ingest(futu, { steps: ['profile'], only: ['0005'] });
    expect(items[0]).toMatchObject({ step: 'profile', status: 'ok' });
    expect(items[0]?.detail).toContain('futu: HSBC HOLDINGS, stock lot 400');
    const hsbc = (await findInstrument(db.db, 'HK', '0005')) as Instrument;
    expect(hsbc.multiplier).toBe(400); // from data/hk-board-lots.csv at watchlist add, untouched by the profile step
    expect(hsbc.name).toMatch(/HSBC/);
  });

  it('chains: the HK chain is requested out to the strategy dteMax (180 days) and stored as a futu snapshot', async () => {
    const { futu, calls } = fakeFutu();
    const items = await ingest(futu, { steps: ['chains'], only: ['0700'] });
    expect(items[0]).toMatchObject({ step: 'chains', status: 'ok' });
    // one expiry cannot bracket 30 days, so this fake chain yields no IV30 row
    expect(items[0]?.detail).toMatch(/^futu OpenD: 1 puts over 1 expiries to 180d @ 2026-10-09, no IV30/);
    expect(calls.chain).toEqual([['0700', 14, 180]]);
    // 0700 is the only name with a chain in this database
    const q = await db.db
      .select({ src: optionQuotes.source, tier: optionQuotes.tier, d: optionQuotes.snapshotDate })
      .from(optionQuotes);
    expect(q).toEqual([{ src: 'futu', tier: 'real', d: '2026-10-09' }]);
  });

  it('volatility: OpenD IV history fills the days the app has no row for and leaves its own rows alone', async () => {
    const tencent = (await findInstrument(db.db, 'HK', '0700')) as Instrument;
    // The app's own row (IV30 and skew from a chain) for one of the days OpenD also covers.
    await writeIvDaily(db.db, tencent.id, { day: '2026-10-08', iv30: 0.5, skew25d: 0.02, tier: 'real' });
    const { futu, calls } = fakeFutu();
    const items = await ingest(futu, { steps: ['volatility'], only: ['0700'] });
    expect(items[0]).toMatchObject({ step: 'volatility', status: 'ok' });
    expect(items[0]?.detail).toMatch(/^futu OpenD: 3 IV days to 2026-10-09 \(29\.6%\), 2 new, 1 already stored/);
    expect(calls.iv).toEqual([['0700', '2025-09-05', '2026-10-10']]);
    const rows = await db.db
      .select({ d: ivDaily.day, iv: ivDaily.iv30, skew: ivDaily.skew25d, tier: ivDaily.tier })
      .from(ivDaily)
      .where(eq(ivDaily.instrumentId, tencent.id))
      .orderBy(asc(ivDaily.day));
    expect(rows.map((r) => [r.d, Number(r.iv), r.skew === null ? null : Number(r.skew), r.tier])).toEqual([
      ['2026-10-07', 0.2936, null, 'real'],
      ['2026-10-08', 0.5, 0.02, 'real'],
      ['2026-10-09', 0.2962, null, 'real'],
    ]);
    // Running it again changes nothing.
    const again = await ingest(futu, { steps: ['volatility'], only: ['0700'] });
    expect(again[0]?.detail).toContain('0 new, 3 already stored');
  });

  it('volatility and chains record nothing for a name without listed options, and nothing at all without OpenD', async () => {
    const h = cliHarness(db.url);
    expect((await h.run(['watchlist', 'add', '0001', 'HK'])).code).toBe(0);
    await upsertInstrument(db.db, { market: 'HK', symbol: '0001', hasListedOptions: false });
    const { futu, calls } = fakeFutu();
    const withOpenD = await ingest(futu, { steps: ['volatility', 'chains'], only: ['0001'] });
    expect(withOpenD.map((i) => [i.step, i.status])).toEqual([['chains', 'skipped']]);
    expect(calls.iv).toEqual([]);
    const without = await ingest(undefined, { steps: ['volatility'], only: ['0700'] });
    expect(without).toEqual([]);
  });
});
