import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, count, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findInstrument } from '../../src/db/repos';
import {
  corporateEvents,
  fundamentalStatements,
  fxRates,
  instruments,
  ivDaily,
  jobRuns,
  optionQuotes,
  priceBars,
  skillRuns,
} from '../../src/db/schema';
import { fixtureFileName, requestKey, writeReplayFixture } from '../../src/providers/http-replay';
import { cliHarness, HTTP_BASE, RECORDED_NOW } from '../helpers/cli';
import { seedSkillRun } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
const dirs: string[] = [];
const overlay = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ot-ing-'));
  dirs.push(d);
  return d;
};

const CHART = (s: string) =>
  `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&events=div|split|earn&useYfid=true`;
const baseFixture = (url: string): { body: string } =>
  JSON.parse(readFileSync(join(HTTP_BASE, fixtureFileName(requestKey('GET', url))), 'utf8'));

beforeAll(async () => {
  db = await createTestDb();
  const h = cliHarness(db.url);
  for (const a of [
    ['settings', 'set', 'equity', '2000000', '--base', 'HKD'],
    ['watchlist', 'add', 'AAPL', 'US'],
    ['watchlist', 'add', '0700', 'HK'],
    ['watchlist', 'add', '0005', 'HK'],
  ]) {
    expect((await h.run(a)).code).toBe(0);
  }
});
afterAll(async () => {
  await db.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('ingest --all from recorded fixtures (T2, T5, Phase 1 check)', () => {
  it('ingests bars, indices, FX, fundamentals, events, US chain and IV with no failures', async () => {
    const r = await cliHarness(db.url).run(['ingest', '--all']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const summary = r.out[r.out.length - 1] as string;
    expect(summary).toMatch(/ingest finished: \d+ ok, 0 failed, 3 skipped;/);
    // skipped: HK chains x2 (paste CSV) and the VHSI (no Yahoo history, no data/vhsi.csv)
    expect(r.out.join('\n')).toContain('regime.noVolIndex');

    const aapl = await findInstrument(db.db, 'US', 'AAPL');
    const tencent = await findInstrument(db.db, 'HK', '0700');
    const hsbc = await findInstrument(db.db, 'HK', '0005');
    expect(aapl && tencent && hsbc).toBeTruthy();

    const [{ n: aaplBars } = { n: 0 }] = await db.db
      .select({ n: count() })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, (aapl as { id: number }).id));
    expect(aaplBars).toBeGreaterThan(2400);
    const last = await db.db
      .select({ d: priceBars.day, s: priceBars.source })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, (tencent as { id: number }).id))
      .orderBy(desc(priceBars.day))
      .limit(1);
    expect(last[0]).toEqual({ d: '2026-10-09', s: 'yahoo' });

    // four indices have bars; VHSI has none
    const idx = await db.db
      .select({ s: instruments.symbol, n: count() })
      .from(priceBars)
      .innerJoin(instruments, eq(instruments.id, priceBars.instrumentId))
      .where(eq(instruments.sector, 'INDEX'))
      .groupBy(instruments.symbol);
    expect(Object.fromEntries(idx.map((x) => [x.s, x.n > 2400]))).toEqual({
      SPY: true,
      VIX: true,
      '2800': true,
      HSI: true,
    });

    const fx = await db.db.select({ p: fxRates.pair, n: count() }).from(fxRates).groupBy(fxRates.pair);
    expect(fx.map((x) => x.p).sort()).toEqual(['CNYHKD', 'SGDHKD', 'USDHKD']);
    for (const x of fx) expect(x.n).toBeGreaterThan(2500);

    // metadata from the profile: statements currency and inferred solvency model
    expect(tencent?.providerSymbols.financialCurrency).toBe('CNY');
    expect(tencent?.sector).toBe('Communication Services');
    expect(hsbc?.providerSymbols.financialCurrency).toBe('USD');
    expect(hsbc?.solvencyModel).toBe('financial');
    expect(aapl?.name).toMatch(/Apple/);
  });

  it('T2: HK annual statements get an estimated, clamped reported_at (+90d) and first_seen_at = ingest time', async () => {
    const tencent = (await findInstrument(db.db, 'HK', '0700')) as { id: number };
    const rows = await db.db
      .select()
      .from(fundamentalStatements)
      .where(and(eq(fundamentalStatements.instrumentId, tencent.id), eq(fundamentalStatements.periodType, 'annual')))
      .orderBy(fundamentalStatements.periodEnd);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const l = rows[rows.length - 1] as (typeof rows)[number];
    expect(l.periodEnd).toBe('2025-12-31');
    expect(l.reportedAtEstimated).toBe(true);
    expect(l.reportedAt.toISOString().slice(0, 10)).toBe('2026-03-31'); // 2025-12-31 + 90 days; first seen later (clamp keeps the earlier estimate)
    expect(l.firstSeenAt.toISOString()).toBe(RECORDED_NOW.toISOString());
    expect(l.currency).toBe('CNY');
  });

  it('stores the US chain as a real-tier yahoo snapshot dated by the last session, plus IV30', async () => {
    const aapl = (await findInstrument(db.db, 'US', 'AAPL')) as { id: number };
    const q = await db.db
      .select({ d: optionQuotes.snapshotDate, src: optionQuotes.source, tier: optionQuotes.tier })
      .from(optionQuotes)
      .limit(1);
    expect(q[0]).toEqual({ d: '2026-10-09', src: 'yahoo', tier: 'real' });
    const iv = await db.db.select().from(ivDaily).where(eq(ivDaily.instrumentId, aapl.id));
    expect(iv).toHaveLength(1);
    expect(Number(iv[0]?.iv30)).toBeGreaterThan(0.1);
    expect(iv[0]?.tier).toBe('real');
  });

  it('records Yahoo earnings and logs a job_runs row', async () => {
    const aapl = (await findInstrument(db.db, 'US', 'AAPL')) as { id: number };
    const ev = await db.db
      .select()
      .from(corporateEvents)
      .where(and(eq(corporateEvents.instrumentId, aapl.id), eq(corporateEvents.eventType, 'earnings')));
    expect(ev.map((e) => [e.eventDate, e.confirmed, e.source])).toEqual([['2026-11-02', true, 'yahoo']]);
    const jobs = await db.db.select().from(jobRuns).where(eq(jobRuns.job, 'ingest'));
    expect(jobs.at(-1)?.status).toBe('ok');
  });

  it('a second ingest restates nothing (idempotent) and keeps cached skill results', async () => {
    const aapl = (await findInstrument(db.db, 'US', 'AAPL')) as { id: number };
    await seedSkillRun(db.db, aapl.id, '2026-10-09');
    const r = await cliHarness(db.url).run(['ingest', '--steps', 'bars,fundamentals,events,fx,indices']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).not.toMatch(/[1-9]\d* restated|cached results dropped/);
    const kept = await db.db.select({ n: count() }).from(skillRuns).where(eq(skillRuns.instrumentId, aapl.id));
    expect(kept[0]?.n).toBe(1);
  });
});

describe('restated bars and fallbacks', () => {
  it('Yahoo restating history (a dividend moves adjusted closes) drops cached results from the EARLIEST changed day', async () => {
    const aapl = (await findInstrument(db.db, 'US', 'AAPL')) as { id: number };
    await db.db.delete(skillRuns);
    await seedSkillRun(db.db, aapl.id, '2026-02-02');
    await seedSkillRun(db.db, aapl.id, '2026-10-09');
    // overlay: AAPL history with adjclose scaled by 0.99 from 2026-03-02 onward
    const url = CHART('AAPL');
    const rec = baseFixture(url);
    const doc = JSON.parse(rec.body);
    const res = doc.chart.result[0];
    const ts: number[] = res.timestamp;
    const adj: number[] = res.indicators.adjclose[0].adjclose;
    const cut = Date.parse('2026-03-02T00:00:00Z') / 1000;
    res.indicators.adjclose[0].adjclose = adj.map((v, i) => ((ts[i] as number) >= cut ? v * 0.99 : v));
    const dir = overlay();
    writeReplayFixture(dir, { url, body: JSON.stringify(doc) });
    const r = await cliHarness(db.url, { replayDirs: [dir, HTTP_BASE] }).run([
      'ingest',
      '--steps',
      'bars',
      '--only',
      'AAPL',
    ]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/\d+ restated, 1 cached results dropped/);
    const left = await db.db.select({ d: skillRuns.asOf }).from(skillRuns).where(eq(skillRuns.instrumentId, aapl.id));
    expect(left.map((x) => x.d)).toEqual(['2026-02-02']);
  });

  it('T15: when Yahoo fails for a name, Stooq bars after the stored history are appended with source stooq', async () => {
    const msft = await (async () => {
      const h = cliHarness(db.url);
      expect((await h.run(['watchlist', 'add', 'MSFT', 'US'])).code).toBe(0);
      expect((await h.run(['ingest', '--steps', 'bars', '--only', 'MSFT'])).code).toBe(0);
      return (await findInstrument(db.db, 'US', 'MSFT')) as { id: number };
    })();
    // simulate an overnight gap: the last 3 stored bars are missing
    const lastDays = await db.db
      .select({ d: priceBars.day })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, msft.id))
      .orderBy(desc(priceBars.day))
      .limit(3);
    for (const x of lastDays)
      await db.db.delete(priceBars).where(and(eq(priceBars.instrumentId, msft.id), eq(priceBars.day, x.d)));
    const stored = await db.db
      .select({ d: priceBars.day })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, msft.id))
      .orderBy(desc(priceBars.day))
      .limit(1);
    const lastStored = (stored[0] as { d: string }).d;

    const dir = overlay();
    writeReplayFixture(dir, {
      url: CHART('MSFT'),
      status: 500,
      contentType: 'text/plain',
      body: 'Internal Server Error',
    });
    const csv = [
      'Date,Open,High,Low,Close,Volume',
      `${lastStored},1,1,1,1,1`,
      '2026-10-07,400,405,399,404,100',
      '2026-10-08,404,408,402,406,100',
      '2026-10-09,406,410,405,409,100',
    ].join('\n');
    writeReplayFixture(dir, {
      url: 'https://stooq.com/q/d/l/?s=msft.us&d1=20160101&d2=20261011&i=d',
      contentType: 'text/csv',
      body: csv,
    });
    const r = await cliHarness(db.url, { replayDirs: [dir, HTTP_BASE] }).run([
      'ingest',
      '--steps',
      'bars',
      '--only',
      'MSFT',
    ]);
    expect(r.out.join('\n')).toMatch(/stooq fallback appended \d+ bars/);
    const rows = await db.db
      .select({ d: priceBars.day, s: priceBars.source, c: priceBars.close })
      .from(priceBars)
      .where(eq(priceBars.instrumentId, msft.id))
      .orderBy(desc(priceBars.day))
      .limit(4);
    expect(rows.find((x) => x.d === '2026-10-09')?.s).toBe('stooq');
    // history at or before the last stored day is never overwritten by Stooq's unadjusted data
    expect(rows.find((x) => x.d === lastStored)?.s ?? 'yahoo').toBe('yahoo');
  });

  it('T15: Stooq serving its JavaScript challenge is reported as a failure, nothing is stored', async () => {
    const nvda = await (async () => {
      const h = cliHarness(db.url);
      expect((await h.run(['watchlist', 'add', 'NVDA', 'US'])).code).toBe(0);
      return (await findInstrument(db.db, 'US', 'NVDA')) as { id: number };
    })();
    const dir = overlay();
    writeReplayFixture(dir, {
      url: CHART('NVDA'),
      status: 500,
      contentType: 'text/plain',
      body: 'Internal Server Error',
    });
    writeReplayFixture(dir, {
      url: 'https://stooq.com/q/d/l/?s=nvda.us&d1=20160101&d2=20261011&i=d',
      contentType: 'text/html',
      body: readFileSync(new URL('../fixtures/stooq/challenge.html', import.meta.url), 'utf8'),
    });
    const r = await cliHarness(db.url, { replayDirs: [dir, HTTP_BASE] }).run([
      'ingest',
      '--steps',
      'bars',
      '--only',
      'NVDA',
    ]);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/FAILED .*no bar source worked.*browser-verification/);
    const n = await db.db.select({ n: count() }).from(priceBars).where(eq(priceBars.instrumentId, nvda.id));
    expect(n[0]?.n).toBe(0);
    const jobs = await db.db.select().from(jobRuns).where(eq(jobRuns.job, 'ingest')).orderBy(desc(jobRuns.id)).limit(1);
    expect(jobs[0]?.status).toBe('failed');
  });
});
