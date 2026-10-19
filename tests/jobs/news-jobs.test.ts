import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/context';
import type { Instrument } from '../../src/core/types';
import { openManualPosition } from '../../src/db/position-ops';
import { addToWatchlist, removeFromWatchlist } from '../../src/db/repos';
import { jobRuns, newsItems } from '../../src/db/schema';
import {
  type JobDeps,
  type NewsJobPorts,
  runNewsBriefJob,
  runNewsClassifyJob,
  runNewsFetchJob,
} from '../../src/jobs/jobs';
import { JOB_DEFS, type JobControl, startScheduler } from '../../src/jobs/scheduler';
import { writeReplayFixture } from '../../src/providers/http-replay';
import { yahooRssUrl } from '../../src/providers/news/yahoo-rss';
import { type NewsReplay, newsReplay } from '../helpers/news-replay';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let replay: NewsReplay;
let nke: Instrument;
let tcent: Instrument;
let aapl: Instrument;

const TOP_OF_HOUR = new Date('2026-10-13T00:00:00Z'); // 08:00 HKT Tue
const OFF_HOURS_HALF = new Date('2026-10-13T22:30:00Z'); // 06:30 HKT Wed, 18:30 ET Tue: both markets closed
const AAPL_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>Apple paused-name story</title>
<link>https://finance.yahoo.com/markets/stocks/articles/apple-paused-1.html</link>
<pubDate>Mon, 12 Oct 2026 03:00:00 +0000</pubDate></item></channel></rss>`;

function ctxAt(now: Date, fetchFn: typeof fetch = replay.fetch): CliContext {
  return {
    out: () => {},
    err: () => {},
    now: () => now,
    db: () => db,
    fetch: fetchFn,
    dataDir: '',
    readFile: async () => '',
    fileExists: async () => false,
  };
}
const depsAt = (now: Date, news?: NewsJobPorts, fetchFn?: typeof fetch): JobDeps => ({
  ctx: ctxAt(now, fetchFn),
  notifier: null,
  log: () => {},
  ...(news ? { news } : {}),
});
const runsOf = async (job: string) => db.db.select().from(jobRuns).where(eq(jobRuns.job, job)).orderBy(jobRuns.id);

beforeAll(async () => {
  db = await createTestDb();
  replay = newsReplay();
  writeReplayFixture(replay.dir, { url: yahooRssUrl('AAPL'), body: AAPL_FEED, contentType: 'application/rss+xml' });
  nke = await seedInstrument(db.db, 'US', 'NKE', { name: 'NIKE' });
  tcent = await seedInstrument(db.db, 'HK', '0700', { name: 'Tencent' });
  aapl = await seedInstrument(db.db, 'US', 'AAPL', { name: 'Apple' });
  await addToWatchlist(db.db, nke.id);
  await addToWatchlist(db.db, tcent.id);
});
afterAll(async () => {
  replay.cleanup();
  await db.drop();
});

describe('registration', () => {
  it('registers the three news jobs: fetch on a 30-minute tick, classify queued by fetch, brief at 06:00, 07:30 and 21:00 HKT', () => {
    const by = Object.fromEntries(JOB_DEFS.map((j) => [j.name, j]));
    expect(by['news-fetch']?.cron).toBe('*/30 * * * *');
    expect(by['news-classify']?.cron).toBeNull();
    expect(by['news-brief']?.cron).toBe('30 7 * * *');
    expect(by['news-brief']?.tz).toBe('Asia/Hong_Kong');
    expect(by['news-brief']?.data).toEqual({ session: 'hk_open' });
    expect(by['news-brief']?.also).toEqual([
      { key: 'morning', cron: '0 6 * * *', tz: 'Asia/Hong_Kong', data: { session: 'hk_open' } },
      { key: 'us_open', cron: '0 21 * * *', tz: 'Asia/Hong_Kong', data: { session: 'us_open' } },
    ]);
  });

  it('the real scheduler creates the three news queues and the schedules in pg-boss', async () => {
    const scheduler = await startScheduler({ connectionString: db.url, deps: depsAt(TOP_OF_HOUR) });
    try {
      const queues = await db.db.execute(sql`select name from pgboss.queue where name like 'news-%' order by name`);
      expect((queues.rows as { name: string }[]).map((r) => r.name)).toEqual([
        'news-brief',
        'news-classify',
        'news-fetch',
      ]);
      const sched = await db.db.execute(
        sql`select name, key, cron, timezone, data from pgboss.schedule where name like 'news-%' order by name, key`,
      );
      expect(sched.rows).toEqual([
        { name: 'news-brief', key: '', cron: '30 7 * * *', timezone: 'Asia/Hong_Kong', data: { session: 'hk_open' } },
        {
          name: 'news-brief',
          key: 'morning',
          cron: '0 6 * * *',
          timezone: 'Asia/Hong_Kong',
          data: { session: 'hk_open' },
        },
        {
          name: 'news-brief',
          key: 'us_open',
          cron: '0 21 * * *',
          timezone: 'Asia/Hong_Kong',
          data: { session: 'us_open' },
        },
        { name: 'news-fetch', key: '', cron: '*/30 * * * *', timezone: 'UTC', data: null },
      ]); // news-classify has a queue and a worker but no schedule: news-fetch queues it
    } finally {
      await scheduler.stop();
    }
  }, 40_000);
});

describe('news-fetch', () => {
  it('skips the :30 tick outside market hours without writing a job run', async () => {
    const out = await runNewsFetchJob(depsAt(OFF_HOURS_HALF), { scheduled: true });
    expect(out).toMatchObject({ status: 'ok', rows: 0 });
    expect(out.detail).toMatch(/off-hours/);
    expect(await runsOf('news-fetch')).toHaveLength(0);
    expect(await db.db.select().from(newsItems)).toHaveLength(0);
  });

  it('a person running it by hand is never skipped', async () => {
    const out = await runNewsFetchJob(depsAt(OFF_HOURS_HALF));
    expect(out.status).toBe('partial'); // no fixture for the HKEX search window of that day: one feed fails, the rest deliver
    expect(out.rows).toBeGreaterThan(5);
    expect(await runsOf('news-fetch')).toHaveLength(1);
  });

  it('stores stories per name and the market-wide ones with no name, deduped on the canonical url', async () => {
    await db.db.delete(newsItems);
    const out = await runNewsFetchJob(depsAt(TOP_OF_HOUR), { scheduled: true });
    expect(out.status).toBe('ok');
    expect(out.detail).toMatch(/\d+ new of \d+ stories from 7\/7 feeds/);
    const rows = await db.db.select().from(newsItems);
    const by = (id: number | null) => rows.filter((r) => r.instrumentId === id);
    expect(by(nke.id)).toHaveLength(4); // 5 items, one duplicate once the tracking parameter is stripped
    expect(by(tcent.id)).toHaveLength(2 + 3); // Yahoo + HKEXnews
    expect(
      by(null)
        .map((r) => r.source)
        .sort(),
    ).toEqual(['CNBC', 'CNBC', 'Yahoo Finance', 'Yahoo Finance', 'Yahoo Finance', 'Yahoo Finance']);
    // the story shared by Tencent's feed and the S&P feed is one row for the name and one market-wide row
    expect(rows.filter((r) => r.title === 'HK tech leads the rebound')).toHaveLength(2);
    expect(rows.every((r) => r.url.startsWith('https://') && !r.url.includes('.tsrc'))).toBe(true);
    expect(rows.every((r) => r.hash.length === 64)).toBe(true);
    expect(rows.every((r) => r.aiImpact === null && r.aiKnownAt === null)).toBe(true);
  });

  it('a second run adds nothing and reports it', async () => {
    const before = (await db.db.select().from(newsItems)).length;
    const out = await runNewsFetchJob(depsAt(TOP_OF_HOUR));
    expect(out.rows).toBe(0);
    expect((await db.db.select().from(newsItems)).length).toBe(before);
  });

  it('fetches a name that was paused after a put was opened on it', async () => {
    await addToWatchlist(db.db, aapl.id);
    await removeFromWatchlist(db.db, aapl.id);
    await openManualPosition(db.db, {
      instrument: aapl,
      strike: 200,
      expiry: '2026-11-20',
      contracts: 1,
      price: 2,
      date: '2026-10-05',
    });
    const out = await runNewsFetchJob(depsAt(TOP_OF_HOUR));
    expect(out.rows).toBe(1);
    const rows = await db.db.select().from(newsItems).where(eq(newsItems.instrumentId, aapl.id));
    expect(rows.map((r) => r.title)).toEqual(['Apple paused-name story']);
  });

  it('reports every feed failing as a failed run, and keeps what it already has', async () => {
    const before = (await db.db.select().from(newsItems)).length;
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    const out = await runNewsFetchJob(depsAt(TOP_OF_HOUR, undefined, down));
    expect(out.status).toBe('failed');
    expect(out.rows).toBe(0);
    expect((await db.db.select().from(newsItems)).length).toBe(before);
    const last = (await runsOf('news-fetch')).at(-1);
    expect(last?.status).toBe('failed');
  });

  it('on the schedule, queues classification after a fetch that found new stories, and not after one that found none', async () => {
    const def = JOB_DEFS.find((j) => j.name === 'news-fetch');
    const queued: string[] = [];
    const ctl: JobControl = {
      trigger: async (name) => {
        queued.push(name);
        return 'id';
      },
      scheduled: true,
      data: {},
    };
    await db.db.delete(newsItems);
    await def?.run(depsAt(TOP_OF_HOUR), ctl);
    expect(queued).toEqual(['news-classify']);
    queued.length = 0;
    await def?.run(depsAt(TOP_OF_HOUR), ctl);
    expect(queued).toEqual([]);
  });
});

describe('model-bound jobs', () => {
  const ports = (auto: boolean, log: string[]): NewsJobPorts => ({
    auto,
    classify: async () => {
      log.push('classify');
      return { rows: 3, failed: false, detail: '3 classified' };
    },
    brief: async (session) => {
      log.push(`brief:${session}`);
      return { rows: 1, failed: false, detail: 'written' };
    },
  });

  it('say so and do nothing when no model is attached (the CLI)', async () => {
    expect(await runNewsClassifyJob(depsAt(TOP_OF_HOUR))).toMatchObject({ status: 'ok', rows: 0 });
    expect((await runNewsBriefJob(depsAt(TOP_OF_HOUR), 'hk_open')).detail).toMatch(/no model attached/);
  });

  it('OT_AI_AUTO=off keeps the schedule from calling the model but not a person', async () => {
    const log: string[] = [];
    const off = ports(false, log);
    expect((await runNewsClassifyJob(depsAt(TOP_OF_HOUR, off), { scheduled: true })).detail).toMatch(/off/);
    expect((await runNewsBriefJob(depsAt(TOP_OF_HOUR, off), 'hk_open', { scheduled: true })).detail).toMatch(/off/);
    expect(log).toEqual([]);
    await runNewsClassifyJob(depsAt(TOP_OF_HOUR, off));
    expect(log).toEqual(['classify']);
  });

  it('writes a brief on a trading day of its market only', async () => {
    const log: string[] = [];
    const on = ports(true, log);
    // Tue 13 Oct 07:30 HKT
    await runNewsBriefJob(depsAt(new Date('2026-10-12T23:30:00Z'), on), 'hk_open', { scheduled: true });
    // Sat 10 Oct 07:30 HKT: no brief
    const sat = await runNewsBriefJob(depsAt(new Date('2026-10-09T23:30:00Z'), on), 'hk_open', { scheduled: true });
    expect(sat.detail).toMatch(/not a Hong Kong trading day/);
    expect(log).toEqual(['brief:hk_open']);
    expect((await runsOf('news-brief')).map((r) => r.status)).toEqual(['ok']);
  });

  it('the brief job takes its session from the schedule that fired it', async () => {
    const def = JOB_DEFS.find((j) => j.name === 'news-brief');
    const log: string[] = [];
    const on = ports(true, log);
    const ctl = (session: string): JobControl => ({ trigger: async () => null, scheduled: false, data: { session } });
    await def?.run(depsAt(TOP_OF_HOUR, on), ctl('us_open'));
    await def?.run(depsAt(TOP_OF_HOUR, on), ctl('hk_open'));
    await def?.run(depsAt(TOP_OF_HOUR, on));
    expect(log).toEqual(['brief:us_open', 'brief:hk_open', 'brief:hk_open']);
  });

  it('a failed brief is a failed job run', async () => {
    const failing: NewsJobPorts = {
      auto: true,
      classify: async () => ({ rows: 0, failed: false, detail: '' }),
      brief: async () => ({ rows: 0, failed: true, detail: 'rejected: cites a url we did not fetch' }),
    };
    const out = await runNewsBriefJob(depsAt(TOP_OF_HOUR, failing), 'us_open');
    expect(out).toMatchObject({ status: 'failed', detail: 'rejected: cites a url we did not fetch' });
  });
});
