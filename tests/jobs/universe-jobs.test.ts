import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/context';
import { type Market, tradingDaysBetween } from '../../src/core/calendar';
import { addDays, diffDays, type ISODate } from '../../src/core/dates';
import { addToWatchlist, findInstrument, lastBarDay } from '../../src/db/repos';
import { jobRuns, priceBars, universeMembers } from '../../src/db/schema';
import { activeUniverseCounts, syncUniverse, type UniverseMember } from '../../src/db/universe';
import type { JobDeps } from '../../src/jobs/jobs';
import {
  lastCompletedSession,
  runUniverseIngestJob,
  runUniverseRefreshJob,
  seedUniverse,
} from '../../src/jobs/universe-jobs';
import { createReplayFetch, writeReplayFixture } from '../../src/providers/http-replay';
import { ingestUniverseBars } from '../../src/providers/universe/ingest';
import { wikiApiUrl } from '../../src/providers/universe/wikipedia';
import { YahooClient } from '../../src/providers/yahoo/client';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';
import { UNIVERSE_FIXTURE_COUNTS, universeReplay } from '../helpers/universe-replay';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ot-uj-'));
  dirs.push(d);
  return d;
};
const dbs: TestDb[] = [];
const newDb = async (): Promise<TestDb> => {
  const d = await createTestDb();
  dbs.push(d);
  return d;
};
// A shared database per purpose keeps the number of clones (and drops) down.
const shared = new Map<string, Promise<TestDb>>();
const sharedDb = (name: string): Promise<TestDb> => {
  let p = shared.get(name);
  if (!p) {
    p = newDb();
    shared.set(name, p);
  }
  return p;
};
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------ session cut-off
describe('lastCompletedSession', () => {
  const at = (iso: string, m: Market) => lastCompletedSession(new Date(iso), m);

  it('HK: today after 16:30 HKT, the previous trading day before it, Friday over a weekend', () => {
    expect(at('2026-10-13T09:45:00Z', 'HK')).toBe('2026-10-13'); // Tue 17:45 HKT
    expect(at('2026-10-13T08:29:00Z', 'HK')).toBe('2026-10-12'); // Tue 16:29 HKT: still inside the cut-off
    expect(at('2026-10-13T08:30:00Z', 'HK')).toBe('2026-10-13'); // 16:30 HKT
    expect(at('2026-10-13T00:30:00Z', 'HK')).toBe('2026-10-12'); // Tue 08:30 HKT
    expect(at('2026-10-17T00:30:00Z', 'HK')).toBe('2026-10-16'); // Sat morning
    expect(at('2026-10-17T10:00:00Z', 'HK')).toBe('2026-10-16'); // Sat evening
  });

  it('HK: skips an exchange holiday (Chung Yeung, Mon 19 Oct 2026)', () => {
    expect(at('2026-10-19T10:00:00Z', 'HK')).toBe('2026-10-16');
    expect(at('2026-10-20T00:30:00Z', 'HK')).toBe('2026-10-16');
  });

  it('US: uses New York time, so the HK evening is still the previous session', () => {
    expect(at('2026-10-13T09:45:00Z', 'US')).toBe('2026-10-12'); // Tue 05:45 EDT
    expect(at('2026-10-13T21:45:00Z', 'US')).toBe('2026-10-13'); // Tue 17:45 EDT
    expect(at('2026-10-13T20:29:00Z', 'US')).toBe('2026-10-12'); // 16:29 EDT
    expect(at('2026-10-12T21:45:00Z', 'US')).toBe('2026-10-12'); // Mon evening
    expect(at('2026-10-12T14:00:00Z', 'US')).toBe('2026-10-09'); // Mon morning: Friday
  });
});

// ------------------------------------------------------------------------------------- bars ingest
const CHART = (s: string): string =>
  `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&events=div|split|earn&useYfid=true`;

/** A Yahoo chart response with `n` daily bars ending on `endDay`. */
function chartBody(market: Market, endDay: ISODate, n = 40): string {
  const days = tradingDaysBetween(market, addDays(endDay, -90), endDay).slice(-n);
  const hour = market === 'HK' ? '01:30:00Z' : '13:30:00Z';
  const stamp = (d: ISODate): number => Math.floor(new Date(`${d}T${hour}`).getTime() / 1000);
  const close = days.map((d) => 100 + diffDays(d, '2026-01-01') * 0.1);
  return JSON.stringify({
    chart: {
      error: null,
      result: [
        {
          meta: {
            currency: market === 'HK' ? 'HKD' : 'USD',
            exchangeTimezoneName: market === 'HK' ? 'Asia/Hong_Kong' : 'America/New_York',
            regularMarketPrice: close[close.length - 1],
          },
          timestamp: days.map(stamp),
          indicators: {
            quote: [
              {
                open: close,
                high: close.map((c) => c + 1),
                low: close.map((c) => c - 1),
                close,
                volume: close.map(() => 1000),
              },
            ],
            adjclose: [{ adjclose: close }],
          },
        },
      ],
    },
  });
}

const NOT_FOUND = JSON.stringify({
  chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
});

interface ChartHooks {
  /** Answers a chart request instead of the replay (return null to fall through). */
  onChart?(symbol: string, url: URL): Response | null;
}

/** Replay of Yahoo chart responses written into `dirs`, counting the chart requests like a network meter. */
function yahooReplay(dirs: string[], hooks: ChartHooks = {}) {
  const base = createReplayFetch(dirs);
  const chartUrls: URL[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.pathname.startsWith('/v8/finance/chart/')) {
      chartUrls.push(url);
      const symbol = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const forced = hooks.onChart?.(symbol, url);
      if (forced) return forced;
    }
    return base(input, init);
  };
  return {
    fetch: fetchFn,
    chartUrls,
    symbols: (): string[] => chartUrls.map((u) => decodeURIComponent(u.pathname.split('/').pop() ?? '')).sort(),
    reset: (): void => {
      chartUrls.length = 0;
    },
  };
}

const periodStart = (u: URL): ISODate =>
  new Date(Number(u.searchParams.get('period1')) * 1000).toISOString().slice(0, 10);

const NOW_US = new Date('2026-10-13T21:45:00Z'); // 17:45 EDT Tue: the session of 13 Oct is complete
const NOW_HK = new Date('2026-10-13T09:45:00Z'); // 17:45 HKT Tue

function ctxAt(db: TestDb, now: Date, fetchFn: typeof fetch): CliContext {
  return {
    out: () => {},
    err: () => {},
    now: () => now,
    db: () => db,
    fetch: fetchFn,
    dataDir: 'data',
    readFile: (p) => readFile(p, 'utf8'),
    fileExists: async () => true,
  };
}
const depsAt = (db: TestDb, now: Date, fetchFn: typeof fetch, lines: string[] = []): JobDeps => ({
  ctx: ctxAt(db, now, fetchFn),
  notifier: null,
  log: (l) => lines.push(l),
});

const usMember = (symbol: string): UniverseMember => ({
  market: 'US',
  symbol,
  name: `${symbol} Corp`,
  sector: 'Industrials',
  indexCode: 'SPX',
});
const hkMember = (symbol: string): UniverseMember => ({
  market: 'HK',
  symbol,
  name: `HK ${symbol}`,
  sector: null,
  indexCode: 'HSCI',
  stockLot: 500,
});
const barCount = async (db: TestDb, market: Market, symbol: string): Promise<number> => {
  const inst = await findInstrument(db.db, market, symbol);
  if (!inst) return -1;
  const [r] = await db.db.select({ n: count() }).from(priceBars).where(eq(priceBars.instrumentId, inst.id));
  return r?.n ?? 0;
};
const jobRows = (db: TestDb, job: string) =>
  db.db.select().from(jobRuns).where(eq(jobRuns.job, job)).orderBy(jobRuns.id);

describe('ingest-universe jobs', () => {
  let db: TestDb;
  let dir: string;

  beforeAll(async () => {
    db = await newDb();
    dir = tmp();
    // US: two that work, one that errors, one Yahoo does not know; WLK is on the watchlist and must be left to the watchlist ingest
    await syncUniverse(
      db.db,
      ['UJA1', 'UJA2', 'UJB3', 'UJC4', 'WLK1'].map(usMember).concat(['1601', '1602', '1603'].map(hkMember)),
      '2026-10-13',
    );
    const wl = await findInstrument(db.db, 'US', 'WLK1');
    await addToWatchlist(db.db, (wl as { id: number }).id);
    for (const s of ['UJA1', 'UJA2', 'WLK1'])
      writeReplayFixture(dir, { url: CHART(s), body: chartBody('US', '2026-10-13') });
    writeReplayFixture(dir, { url: CHART('UJB3'), status: 500, contentType: 'text/plain', body: 'boom' });
    writeReplayFixture(dir, { url: CHART('UJC4'), status: 404, body: NOT_FOUND });
    for (const s of ['1601.HK', '1602.HK', '1603.HK'])
      writeReplayFixture(dir, { url: CHART(s), body: chartBody('HK', '2026-10-13') });
  });

  it('first load: 450 days for every universe name off the watchlist; a failing name does not abort the run', async () => {
    const y = yahooReplay([dir]);
    const lines: string[] = [];
    const out = await runUniverseIngestJob(depsAt(db, NOW_US, y.fetch, lines), { market: 'US' });
    expect(y.symbols()).toEqual(['UJA1', 'UJA2', 'UJB3', 'UJC4']); // not WLK1: it is on the watchlist
    for (const u of y.chartUrls) expect(periodStart(u)).toBe(addDays('2026-10-13', -450));
    expect(out.status).toBe('partial');
    expect(out.rows).toBe(80);
    expect(out.detail).toMatch(/2026-10-13: 4 names, 2 fetched, 0 up to date, 1 failed, 1 not found, 80 rows/);
    expect(out.detail).toMatch(/UJB3/);
    expect(await barCount(db, 'US', 'UJA1')).toBe(40);
    expect(await lastBarDay(db.db, (await findInstrument(db.db, 'US', 'UJA2'))?.id as number)).toBe('2026-10-13');
    expect(await barCount(db, 'US', 'UJB3')).toBe(0);
    expect(await barCount(db, 'US', 'WLK1')).toBe(0);
    const [row] = await jobRows(db, 'ingest-universe-us');
    expect(row).toMatchObject({ status: 'partial', rowsWritten: 80 });
    expect(lines.some((l) => /universe bars US as of 2026-10-13: 4 names, 2 fetched/.test(l))).toBe(true);
  });

  it('a warm run asks for nothing that is already current: only the two names that have no bars are tried again', async () => {
    const y = yahooReplay([dir]);
    const out = await runUniverseIngestJob(depsAt(db, NOW_US, y.fetch), { market: 'US' });
    expect(y.symbols()).toEqual(['UJB3', 'UJC4']);
    expect(out.detail).toMatch(/4 names, 0 fetched, 2 up to date, 1 failed, 1 not found, 0 rows/);
    expect(await barCount(db, 'US', 'UJA1')).toBe(40);
  });

  it('HK: all names load on the first run and the second run makes zero HTTP calls', async () => {
    const first = yahooReplay([dir]);
    const out1 = await runUniverseIngestJob(depsAt(db, NOW_HK, first.fetch), { market: 'HK' });
    expect(first.symbols()).toEqual(['1601.HK', '1602.HK', '1603.HK']);
    expect(out1).toMatchObject({ status: 'ok', rows: 120 });
    expect(await barCount(db, 'HK', '1601')).toBe(40);

    const warm = yahooReplay([dir]);
    const out2 = await runUniverseIngestJob(depsAt(db, NOW_HK, warm.fetch), { market: 'HK' });
    expect(warm.chartUrls).toHaveLength(0);
    expect(out2).toMatchObject({ status: 'ok', rows: 0 });
    expect(out2.detail).toMatch(/3 names, 0 fetched, 3 up to date, 0 failed, 0 not found, 0 rows/);
    expect((await jobRows(db, 'ingest-universe-hk')).map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('an explicit as-of overrides the cut-off, and a name already at that session is skipped', async () => {
    const y = yahooReplay([dir]);
    const out = await runUniverseIngestJob(depsAt(db, NOW_HK, y.fetch), { market: 'HK', asOf: '2026-10-09' });
    expect(y.chartUrls).toHaveLength(0);
    expect(out.detail).toMatch(/^2026-10-09: 3 names/);
  });

  it('the next session is incremental: the window starts 10 days before the newest bar and only the new bar is written', async () => {
    const next = tmp();
    writeReplayFixture(next, { url: CHART('1601.HK'), body: chartBody('HK', '2026-10-14') });
    writeReplayFixture(next, { url: CHART('1602.HK'), body: chartBody('HK', '2026-10-14') });
    writeReplayFixture(next, { url: CHART('1603.HK'), body: chartBody('HK', '2026-10-14') });
    const y = yahooReplay([next, dir]);
    const out = await runUniverseIngestJob(depsAt(db, new Date('2026-10-14T09:45:00Z'), y.fetch), { market: 'HK' });
    expect(y.symbols()).toEqual(['1601.HK', '1602.HK', '1603.HK']);
    for (const u of y.chartUrls) expect(periodStart(u)).toBe('2026-10-03');
    // the overlap days come back identical (no restatement) and the 14th is new
    expect(out.status).toBe('ok');
    expect(await lastBarDay(db.db, (await findInstrument(db.db, 'HK', '1601'))?.id as number)).toBe('2026-10-14');
    expect(await barCount(db, 'HK', '1601')).toBe(41);
  });

  it('a rate-limited request is retried once; the pool never runs more requests at a time than asked for', async () => {
    const rl = await sharedDb('scratch');
    await syncUniverse(rl.db, ['RLA1', 'RLA2', 'RLA3', 'RLA4', 'RLA5', 'RLA6'].map(usMember), '2026-10-13');
    const d = tmp();
    for (const s of ['RLA1', 'RLA2', 'RLA3', 'RLA4', 'RLA5', 'RLA6'])
      writeReplayFixture(d, { url: CHART(s), body: chartBody('US', '2026-10-13', 10) });
    let limited = false;
    let inflight = 0;
    let peak = 0;
    const base = yahooReplay([d], {
      onChart: (symbol) => {
        if (symbol === 'RLA3' && !limited) {
          limited = true;
          return new Response('Too Many Requests', { status: 429, headers: { 'content-type': 'text/plain' } });
        }
        return null;
      },
    });
    const metered: typeof fetch = async (input, init) => {
      const isChart = String(
        input instanceof URL ? input.href : typeof input === 'string' ? input : (input as Request).url,
      ).includes('/v8/finance/chart/');
      if (isChart) peak = Math.max(peak, ++inflight);
      try {
        if (isChart) await new Promise((r) => setTimeout(r, 15));
        return await base.fetch(input, init);
      } finally {
        if (isChart) inflight--;
      }
    };
    const res = await ingestUniverseBars(
      { db: rl.db, client: new YahooClient({ fetch: metered }), now: NOW_US, retryDelayMs: 0 },
      { market: 'US', asOf: '2026-10-13', concurrency: 1 },
    );
    expect(res).toMatchObject({ names: 6, fetched: 6, failed: 0, notFound: 0, skipped: 0, rows: 60 });
    expect(peak).toBe(1);
    expect(base.symbols().filter((s) => s === 'RLA3')).toHaveLength(2); // the 429 and the retry
  });

  it('progress is reported per name', async () => {
    const pr = await sharedDb('scratch');
    await syncUniverse(pr.db, ['PRA1', 'PRA2'].map(usMember), '2026-10-13');
    const d = tmp();
    writeReplayFixture(d, { url: CHART('PRA1'), body: chartBody('US', '2026-10-13', 5) });
    writeReplayFixture(d, { url: CHART('PRA2'), status: 404, body: NOT_FOUND });
    const seen: string[] = [];
    await ingestUniverseBars(
      {
        db: pr.db,
        client: new YahooClient({ fetch: yahooReplay([d]).fetch }),
        now: NOW_US,
        onItem: (i) => seen.push(`${i.symbol}:${i.status}`),
      },
      { market: 'US', asOf: '2026-10-13' },
    );
    expect(seen.filter((x) => x.startsWith('PRA')).sort()).toEqual(['PRA1:fetched', 'PRA2:not_found']);
  });

  it('an empty universe is a clean no-op that says why', async () => {
    const empty = await sharedDb('empty');
    const y = yahooReplay([dir]);
    const out = await runUniverseIngestJob(depsAt(empty, NOW_US, y.fetch), { market: 'US' });
    expect(out).toMatchObject({ status: 'ok', rows: 0 });
    expect(out.detail).toMatch(/no US universe names/);
    expect(y.chartUrls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------ refresh
describe('universe-refresh job', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await newDb();
  });

  it('first run loads every list, then a second run over the same data changes nothing', async () => {
    const r = universeReplay();
    const lines: string[] = [];
    const first = await runUniverseRefreshJob(depsAt(db, NOW_HK, r.fetch, lines));
    r.cleanup();
    expect(first.status).toBe('ok');
    expect(first.detail).toMatch(/SPX 503, NDX 101, MID 400/);
    expect(first.detail).toMatch(/HSI 95, HSCEI 50, HSTECH 30, HSCI 519/);
    const counts = await activeUniverseCounts(db.db);
    expect(counts.byIndex).toEqual(UNIVERSE_FIXTURE_COUNTS);
    expect(counts.byMarket.HK).toBe(519);
    expect(counts.byMarket.US).toBeGreaterThan(900);
    expect(first.rows).toBe(Object.values(UNIVERSE_FIXTURE_COUNTS).reduce((a, b) => a + b, 0));
    // the composite's known gap is logged, not turned into a degraded status
    expect(lines.some((l) => /HSCI: 519 of the 581/.test(l))).toBe(true);

    const tencent = await findInstrument(db.db, 'HK', '0700');
    expect(tencent).toMatchObject({ hasListedOptions: false, multiplier: 100 });
    expect(tencent?.providerSymbols).toEqual({ stockLot: 100 });
    expect((await findInstrument(db.db, 'HK', '2910'))?.providerSymbols).toEqual({ lotAssumed: true });
    expect((await findInstrument(db.db, 'US', 'BRK.B'))?.name).toBe('Berkshire Hathaway');

    const r2 = universeReplay();
    const second = await runUniverseRefreshJob(depsAt(db, new Date('2026-10-20T00:30:00Z'), r2.fetch));
    r2.cleanup();
    expect(second).toMatchObject({ status: 'ok', rows: 0 });
    expect((await jobRows(db, 'universe-refresh')).map((x) => x.status)).toEqual(['ok', 'ok']);
  });

  it('a source that fails falls back to the seed CSV for that index (adds only) and the run is partial', async () => {
    const down = universeReplay((url) =>
      url === wikiApiUrl('List_of_NASDAQ-100_companies') || url === wikiApiUrl('Nasdaq-100')
        ? new Response('down', { status: 503 })
        : null,
    );
    const lines: string[] = [];
    const out = await runUniverseRefreshJob(depsAt(db, new Date('2026-10-27T00:30:00Z'), down.fetch, lines));
    down.cleanup();
    expect(out.status).toBe('partial');
    expect(out.detail).toMatch(/NDX FAILED/);
    expect(lines.some((l) => /NDX live source failed/.test(l))).toBe(true);
    expect(lines.some((l) => /NDX taken from universe-us\.csv/.test(l))).toBe(true);
    // nothing was removed and the index is still whole
    expect((await activeUniverseCounts(db.db)).byIndex.NDX).toBe(101);
    const [removed] = await db.db
      .select({ n: count() })
      .from(universeMembers)
      .where(and(eq(universeMembers.indexCode, 'NDX'), isNotNull(universeMembers.removedAt)));
    expect(removed?.n).toBe(0);
  });

  it('flags a refresh that would remove more than 10% of a market instead of applying it', async () => {
    const ghosts = Array.from({ length: 150 }, (_v, i) => usMember(`ZZ${String(i).padStart(3, '0')}`));
    await syncUniverse(db.db, ghosts, '2026-10-27'); // 150 names the live SPX list does not have
    const r = universeReplay();
    const lines: string[] = [];
    const out = await runUniverseRefreshJob(depsAt(db, new Date('2026-11-03T00:30:00Z'), r.fetch, lines));
    r.cleanup();
    expect(out.status).toBe('partial');
    expect(out.detail).toMatch(/FLAGGED/);
    expect(lines.some((l) => /FLAG US: 150 of 1154 memberships would be removed/.test(l))).toBe(true);
    // the 150 stay active; nothing else changed
    expect((await activeUniverseCounts(db.db)).byIndex.SPX).toBe(503 + 150);
    expect(out.rows).toBe(0);
  });

  it('with every live source down and no seed, the run fails softly and changes nothing', async () => {
    const empty = await sharedDb('empty');
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const deps = depsAt(empty, NOW_HK, down);
    deps.ctx = { ...deps.ctx, dataDir: join(tmp(), 'no-such-dir') };
    const out = await runUniverseRefreshJob(deps);
    expect(out.status).toBe('failed');
    expect(out.detail).toMatch(/every live source failed/);
    expect((await activeUniverseCounts(empty.db)).byMarket).toEqual({ US: 0, HK: 0 });
    expect((await jobRows(empty, 'universe-refresh'))[0]?.status).toBe('failed');
  });
});

// -------------------------------------------------------------------------------------------- seed
describe('seedUniverse', () => {
  const read = (p: string): Promise<string> => readFile(p, 'utf8');

  it('loads both committed seed CSVs into a fresh database with no network, and a second call adds nothing', async () => {
    const db = await newDb();
    const out = await seedUniverse(db.db, 'data', read, '2026-10-13');
    expect(out.missing).toEqual([]);
    expect(out.files.map((f) => f.market)).toEqual(['US', 'HK']);
    expect(out.sync.flagged).toEqual([]);
    expect(out.sync.removed).toBe(0);
    expect(out.sync.created).toBeGreaterThan(1400);
    const c = await activeUniverseCounts(db.db);
    expect(c.byIndex.SPX).toBeGreaterThanOrEqual(495);
    expect(c.byIndex.HSCI).toBeGreaterThanOrEqual(400);
    expect(c.byMarket.US).toBeGreaterThan(900);
    expect((await findInstrument(db.db, 'HK', '9988'))?.providerSymbols).toEqual({ stockLot: 100 });
    const again = await seedUniverse(db.db, 'data', read, '2026-10-14');
    expect(again.sync).toMatchObject({ added: 0, reactivated: 0, removed: 0, created: 0 });
    // add-only: a name the seed does not list is not stamped removed by a seed run
    await syncUniverse(db.db, [usMember('SEEDGHOST')], '2026-10-15');
    await seedUniverse(db.db, 'data', read, '2026-10-16');
    const ghost = await findInstrument(db.db, 'US', 'SEEDGHOST');
    const [row] = await db.db
      .select()
      .from(universeMembers)
      .where(eq(universeMembers.instrumentId, ghost?.id as number));
    expect(row?.removedAt).toBeNull();
  });

  it('missing seed files are reported, not thrown', async () => {
    const db = await sharedDb('empty');
    const out = await seedUniverse(db.db, join(tmp(), 'nope'), read, '2026-10-13');
    expect(out.missing).toEqual(['universe-us.csv', 'universe-hk.csv']);
    expect(out.files).toEqual([]);
    expect(out.sync.instruments).toBe(0);
  });

  it('a seeded watchlist name keeps its option listing and gets only its stock lot', async () => {
    const db = await newDb();
    const aapl = await seedInstrument(db.db, 'US', 'AAPL', { name: 'Apple Inc.', hasListedOptions: true });
    const tencent = await seedInstrument(db.db, 'HK', '0700', {
      boardLot: 100,
      hasListedOptions: true,
      providerSymbols: { yahoo: '0700.HK' },
    });
    await addToWatchlist(db.db, aapl.id);
    await addToWatchlist(db.db, tencent.id);
    const dir = tmp();
    await writeFile(
      join(dir, 'universe-us.csv'),
      'index_code,symbol,name,sector,yahoo,stock_lot\nSPX,AAPL,Apple,Tech,,\nSPX,ZZZ1,Zed,Tech,,\n',
    );
    await writeFile(
      join(dir, 'universe-hk.csv'),
      'index_code,symbol,name,sector,yahoo,stock_lot\nHSI,0700,TENCENT,,,100\nHSI,1999,NEW HK,,,2000\n',
    );
    const out = await seedUniverse(db.db, dir, read, '2026-10-13');
    expect(out.sync).toMatchObject({ added: 4, created: 2, instruments: 4 });
    expect(await findInstrument(db.db, 'US', 'AAPL')).toMatchObject({ name: 'Apple Inc.', hasListedOptions: true });
    expect(await findInstrument(db.db, 'HK', '0700')).toMatchObject({
      hasListedOptions: true,
      multiplier: 100,
      providerSymbols: { yahoo: '0700.HK', stockLot: 100 },
    });
    expect(await findInstrument(db.db, 'US', 'ZZZ1')).toMatchObject({ hasListedOptions: false });
    expect((await findInstrument(db.db, 'HK', '1999'))?.providerSymbols).toEqual({ stockLot: 2000 });
  });
});
