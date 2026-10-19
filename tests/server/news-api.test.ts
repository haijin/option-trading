import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instrument } from '../../src/core/types';
import { openManualPosition } from '../../src/db/position-ops';
import { addToWatchlist } from '../../src/db/repos';
import { jobRuns } from '../../src/db/schema';
import { writeReplayFixture } from '../../src/providers/http-replay';
import { yahooRssUrl } from '../../src/providers/news/yahoo-rss';
import { startApp, type TestApp } from '../helpers/app';
import { NEWS_NOW, type NewsReplay, newsReplay } from '../helpers/news-replay';
import { seedScanRun } from '../helpers/news-world';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let tmp: string;
let replay: NewsReplay;
let t: TestApp;
let nke: Instrument;
let tcent: Instrument;
let aapl: Instrument;

const AAPL_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>Apple supplier update from early October</title>
<link>https://finance.yahoo.com/markets/stocks/articles/apple-supplier-early-oct-1.html?.tsrc=rss</link>
<description>Older than the three-day window.</description>
<pubDate>Thu, 01 Oct 2026 03:00:00 +0000</pubDate></item></channel></rss>`;

beforeAll(async () => {
  db = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'ot-news-'));
  replay = newsReplay();
  writeReplayFixture(replay.dir, { url: yahooRssUrl('AAPL'), body: AAPL_FEED, contentType: 'application/rss+xml' });
  nke = await seedInstrument(db.db, 'US', 'NKE', { name: 'NIKE' });
  tcent = await seedInstrument(db.db, 'HK', '0700', { name: 'Tencent' });
  aapl = await seedInstrument(db.db, 'US', 'AAPL', { name: 'Apple' });
  for (const i of [nke, tcent, aapl]) await addToWatchlist(db.db, i.id);
  // The previous scan recommended Tencent and NIKE; the latest recommends only NIKE: Tencent "fell from sell".
  await seedScanRun(db.db, '2026-10-08', [tcent.id, nke.id], '2026-10-08T22:00:00Z');
  await seedScanRun(db.db, '2026-10-09', [nke.id], '2026-10-09T22:00:00Z');
  await openManualPosition(db.db, {
    instrument: nke,
    strike: 65,
    expiry: '2026-10-30',
    contracts: 1,
    price: 1.2,
    date: '2026-10-05',
  });
  t = await startApp(db, { tmp, fetch: replay.fetch, now: NEWS_NOW });
});
afterAll(async () => {
  await t.close();
  replay.cleanup();
  rmSync(tmp, { recursive: true, force: true });
  await db.drop();
});

describe('before any fetch', () => {
  it('answers with empty groups and every name in the quiet row', async () => {
    const r = await t.get('/api/news?scope=all&days=3');
    expect(r.status).toBe(200);
    expect(r.json.groups).toEqual([]);
    expect(r.json.quiet).toHaveLength(3);
    expect(r.json.status.fetchedAt).toBeNull();
    expect(r.json.status.refreshing).toBe(false);
  });
});

describe('POST /api/news/refresh', () => {
  it('queues a fetch, which stores the stories and records a job run', async () => {
    const r = await t.post('/api/news/refresh');
    expect(r.status).toBe(202);
    expect(r.json.queued).toBe(true);
    await t.app.services.news.idle();
    const runs = await db.db.select().from(jobRuns);
    const fetchRun = runs.find((x) => x.job === 'news-fetch');
    expect(fetchRun?.status).toBe('ok');
    expect((fetchRun?.meta as { detail: string } | null)?.detail).toMatch(/new of \d+ stories from \d+\/\d+ feeds/);
  });

  it('a second refresh stores nothing new (dedupe), and the count is stable', async () => {
    const before = await t.get('/api/news?scope=all&days=30');
    await t.post('/api/news/refresh');
    await t.app.services.news.idle();
    const after = await t.get('/api/news?scope=all&days=30');
    expect(after.json.total).toBe(before.json.total);
    expect(after.json.total).toBeGreaterThan(5);
  });
});

describe('GET /api/news', () => {
  it("shortlist = the latest scan plus names that fell from sell, with each name's standing now", async () => {
    const r = await t.get('/api/news?scope=shortlist&days=3');
    expect(r.status).toBe(200);
    const bySym = Object.fromEntries(r.json.groups.map((g: { symbol: string }) => [g.symbol, g]));
    expect(Object.keys(bySym).sort()).toEqual(['0700', 'NKE']);
    // NIKE has an open put as well as a recommendation: the open put is its standing
    expect(bySym.NKE.standing).toMatchObject({ kind: 'open', label: 'Open put', strike: 65, expiry: '2026-10-30' });
    expect(bySym.NKE.hasOpenPosition).toBe(true);
    expect(bySym['0700'].standing).toMatchObject({ kind: 'wait', label: 'Wait (was Sell)' });
    expect(r.json.counts).toEqual({ shortlist: 2, positions: 1, all: 3 });
    expect(r.json.quiet).toEqual([]);
  });

  it('stories are shown unclassified: no impact, no summary, never Neutral', async () => {
    const r = await t.get('/api/news?scope=shortlist&days=3');
    const nkeItems = r.json.groups.find((g: { symbol: string }) => g.symbol === 'NKE').items;
    expect(nkeItems.length).toBe(4); // five in the feed, one duplicate by canonical url
    for (const i of nkeItems) {
      expect(i.impact).toBeNull();
      expect(i.summary).toBeNull();
      expect(i.rules).toEqual([]);
      expect(i.standingThen).toBeNull();
      expect(i.url).toMatch(/^https:\/\//);
      expect(i.url).not.toContain('.tsrc');
    }
    // newest first
    const times = nkeItems.map((i: { publishedAt: string }) => i.publishedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('positions scope is the open puts only', async () => {
    const r = await t.get('/api/news?scope=positions&days=3');
    expect(r.json.groups.map((g: { symbol: string }) => g.symbol)).toEqual(['NKE']);
  });

  it('all scope lists names with nothing in the window in the quiet row, and the wider window finds the old story', async () => {
    const narrow = await t.get('/api/news?scope=all&days=3');
    expect(narrow.json.quiet).toEqual([{ market: 'US', symbol: 'AAPL' }]);
    const month = await t.get('/api/news?scope=all&days=30');
    expect(month.json.quiet).toEqual([]);
    expect(month.json.groups.map((g: { symbol: string }) => g.symbol)).toContain('AAPL');
  });

  it('a past date ends the window on that Hong Kong day and does not change the standing shown', async () => {
    const r = await t.get('/api/news?scope=all&date=2026-10-12&days=1');
    expect(r.json.date).toBe('2026-10-12');
    expect(r.json.today).toBe('2026-10-13');
    expect(r.json.rolling).toBe(false);
    for (const g of r.json.groups) for (const i of g.items) expect(i.day).toBe('2026-10-12');
    // Tencent: its HKEXnews filings and the shared Yahoo story of that evening; the 07:15 HKT story of 13 Oct is not here
    const tc = r.json.groups.find((g: { symbol: string }) => g.symbol === '0700');
    const titles = tc.items.map((i: { title: string }) => i.title);
    expect(titles).toContain('HK tech leads the rebound');
    expect(titles).not.toContain('Tencent extends its share buyback');
  });

  it('today with a one-day window is the rolling last 24 hours', async () => {
    const r = await t.get('/api/news?scope=all&days=1');
    expect(r.json.rolling).toBe(true);
    expect(r.json.date).toBe('2026-10-13');
  });

  it('a date after today is read as today', async () => {
    const r = await t.get('/api/news?scope=all&date=2027-01-01&days=3');
    expect(r.json.date).toBe('2026-10-13');
  });

  it('shows the paused and unrelated names nowhere', async () => {
    const r = await t.get('/api/news?scope=all&days=30');
    expect(r.json.counts.all).toBe(3);
  });

  it('rejects bad parameters with a 400', async () => {
    for (const q of ['days=5', 'scope=everything', 'date=yesterday', 'neutral=2']) {
      const r = await t.get(`/api/news?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe('validation');
    }
  });

  it('reports the last fetch and whether a model is available', async () => {
    const r = await t.get('/api/news?scope=all&days=3');
    expect(r.json.status.lastFetch.status).toBe('ok');
    expect(r.json.status.fetchedAt).toBe('2026-10-13T00:30:00.000Z');
    expect(r.json.status.unclassified).toBeGreaterThan(0);
    expect(r.json.status.ai).toMatchObject({ model: 'claude-haiku-5-5', budgetUsd: 2, spentTodayUsd: 0 });
    expect(r.json.status.earliestDay).toBe('2026-10-01');
  });
});

describe('GET /api/news/days', () => {
  it('lists the days of a month that have stories, with the scope applied', async () => {
    const all = await t.get('/api/news/days?month=2026-10&scope=all');
    expect(all.status).toBe(200);
    const days = Object.fromEntries(all.json.days.map((d: { day: string; impacts: string[] }) => [d.day, d.impacts]));
    expect(days['2026-10-01']).toEqual(['none']);
    expect(days['2026-10-12']).toEqual(['none']);
    expect(all.json.earliest).toBe('2026-10-01');
    const shortlist = await t.get('/api/news/days?month=2026-10&scope=shortlist');
    expect(shortlist.json.days.map((d: { day: string }) => d.day)).not.toContain('2026-10-01'); // AAPL is not on the shortlist
  });

  it('has no days for a month with nothing, and rejects a malformed month', async () => {
    expect((await t.get('/api/news/days?month=2026-07&scope=all')).json.days).toEqual([]);
    expect((await t.get('/api/news/days?month=2026-13&scope=all')).status).toBe(400);
    expect((await t.get('/api/news/days?scope=all')).status).toBe(400);
  });
});

describe('GET /api/news/search', () => {
  it('finds headlines across all days and ignores the window', async () => {
    const r = await t.get('/api/news/search?q=buyback&scope=all');
    expect(r.status).toBe(200);
    expect(r.json.total).toBeGreaterThanOrEqual(3);
    const titles = r.json.groups.flatMap((g: { items: { title: string }[] }) => g.items.map((i) => i.title));
    expect(titles.every((x: string) => /buyback/i.test(x))).toBe(true);
    expect((await t.get('/api/news/search?q=supplier&scope=all')).json.total).toBe(1);
  });

  it('respects the scope and rejects an empty query', async () => {
    expect((await t.get('/api/news/search?q=supplier&scope=shortlist')).json.total).toBe(0);
    expect((await t.get('/api/news/search?q=&scope=all')).status).toBe(400);
    expect((await t.get('/api/news/search?scope=all')).status).toBe(400);
  });
});

describe('GET /api/news/brief', () => {
  it('says why there is no brief: weekend, not yet, or simply not written', async () => {
    const sat = await t.get('/api/news/brief?date=2026-10-10');
    expect(sat.json).toMatchObject({ date: '2026-10-10', briefs: [], none: 'weekend' });
    expect((await t.get('/api/news/brief?date=2026-12-01')).json.none).toBe('not_yet');
    const tue = await t.get('/api/news/brief?date=2026-10-13');
    expect(tue.json.none).toBe('not_written');
    expect((await t.get('/api/news/brief')).json.date).toBe('2026-10-13');
    expect((await t.get('/api/news/brief?date=nope')).status).toBe(400);
  });
});
