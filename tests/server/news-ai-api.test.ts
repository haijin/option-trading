import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addToWatchlist } from '../../src/db/repos';
import { jobRuns, newsItems } from '../../src/db/schema';
import { FakeExecutor } from '../../src/server/research/executor';
import { startApp, type TestApp } from '../helpers/app';
import { NEWS_NOW, type NewsReplay, newsReplay } from '../helpers/news-replay';
import { briefAnswer, isBriefPrompt, judgement, seedScanRun } from '../helpers/news-world';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

/** The model, scripted by headline: buyback -> supports, Acme Research -> blocks, Digital -> prose (rejected), the rest neutral. */
const scripted = (prompt: string): string => {
  if (isBriefPrompt(prompt)) return briefAnswer();
  const headline = /Headline: (.*)/.exec(prompt)?.[1] ?? '';
  if (/buyback/i.test(headline))
    return judgement({
      impact: 'supports',
      summary: 'the daily buyback keeps a bid under the price',
      rules: [{ key: 't', text: 'support holds' }],
    });
  if (/Acme Research/.test(headline))
    return judgement({
      impact: 'blocks',
      summary: 'a dated event sits inside the put',
      rules: [{ key: 'e', text: 'earnings in the window' }],
    });
  if (/Digital/.test(headline)) return 'I cannot decide.';
  return judgement({ impact: 'neutral', summary: 'no rule touched', rules: [] });
};

interface World {
  db: TestDb;
  tmp: string;
  replay: NewsReplay;
}

async function world(): Promise<World> {
  const db = await createTestDb();
  const tmp = mkdtempSync(join(tmpdir(), 'ot-news-ai-'));
  const replay = newsReplay();
  const nke = await seedInstrument(db.db, 'US', 'NKE', { name: 'NIKE' });
  const tcent = await seedInstrument(db.db, 'HK', '0700', { name: 'Tencent' });
  for (const i of [nke, tcent]) await addToWatchlist(db.db, i.id);
  await seedScanRun(db.db, '2026-10-09', [nke.id, tcent.id], '2026-10-09T22:00:00Z');
  return { db, tmp, replay };
}

async function drop(w: World): Promise<void> {
  w.replay.cleanup();
  rmSync(w.tmp, { recursive: true, force: true });
  await w.db.drop();
}

describe('refresh with a model', () => {
  let w: World;
  let t: TestApp;
  let executor: FakeExecutor;

  beforeAll(async () => {
    w = await world();
    executor = new FakeExecutor({ steps: 0, reply: scripted });
    t = await startApp(w.db, { tmp: w.tmp, fetch: w.replay.fetch, now: NEWS_NOW, executor });
  });
  afterAll(async () => {
    await t.close();
    await drop(w);
  });

  it('reports a model as available before anything is fetched', async () => {
    const r = await t.get('/api/news?scope=all&days=3');
    expect(r.json.status.ai).toMatchObject({
      available: true,
      auto: true,
      model: 'claude-haiku-5-5',
      spentTodayUsd: 0,
    });
  });

  it('Refresh fetches, then judges the new stories and the page shows the impact, the standing then and the rule keys', async () => {
    await t.post('/api/news/refresh');
    await t.app.services.news.idle();
    const r = await t.get('/api/news?scope=shortlist&days=3');
    const nkeItems = r.json.groups.find((g: { symbol: string }) => g.symbol === 'NKE').items;
    const byTitle = Object.fromEntries(nkeItems.map((i: { title: string }) => [i.title, i]));
    const preview = byTitle['Sample Bank, Example Foods and Nike are part of the Acme Research Earnings Preview'];
    expect(preview).toMatchObject({
      impact: 'blocks',
      summary: 'a dated event sits inside the put',
      rules: [{ key: 'e', text: 'earnings in the window' }],
      confidence: 70,
      model: 'fake-model',
      judgedAt: NEWS_NOW.toISOString(),
    });
    expect(preview.standingThen).toMatchObject({ kind: 'sell', label: 'Sell', strike: 65 });
    const buyback = byTitle['Nike & Converse: buyback pace slows'];
    expect(buyback.impact).toBe('supports');
    // the answer that was not valid leaves the story unclassified: no badge, never Neutral
    const digital = byTitle["NIKE's Sample Digital Plan: Competitive Edge or Cost Burden?"];
    expect(digital).toMatchObject({ impact: null, summary: null, rules: [], standingThen: null, judgedAt: null });
  });

  it("records one job run for the fetch and counts the day's spend", async () => {
    const r = await t.get('/api/news?scope=all&days=3');
    const spent = r.json.status.ai.spentTodayUsd;
    const judged = await w.db.db.select().from(newsItems);
    const nJudged = judged.filter((x) => x.aiKnownAt !== null).length;
    expect(nJudged).toBeGreaterThan(5);
    expect(spent).toBeCloseTo((nJudged + 1) * 0.01, 4); // every judgement and the one brief
    expect(executor.prompts.filter((p) => !isBriefPrompt(p))).toHaveLength(nJudged);
    expect((await w.db.db.select().from(jobRuns)).filter((x) => x.job === 'news-fetch')).toHaveLength(1);
  });

  it('the calendar dots now follow the impact words, most severe first', async () => {
    const r = await t.get('/api/news/days?month=2026-10&scope=shortlist');
    const day12 = r.json.days.find((d: { day: string }) => d.day === '2026-10-12');
    expect(day12.impacts[0]).toBe('blocks');
    expect(day12.impacts).toContain('supports');
    const hidden = await t.get('/api/news/days?month=2026-10&scope=shortlist&neutral=0');
    expect(hidden.json.days.find((d: { day: string }) => d.day === '2026-10-12').impacts).not.toContain('neutral');
  });

  it('Hide neutral drops judged-neutral stories but keeps the ones nobody has judged', async () => {
    const all = await t.get('/api/news?scope=shortlist&days=3&neutral=1');
    const hidden = await t.get('/api/news?scope=shortlist&days=3&neutral=0');
    const impacts = (v: typeof all) =>
      v.json.groups.flatMap((g: { items: { impact: string | null }[] }) => g.items.map((i) => i.impact));
    expect(impacts(all)).toContain('neutral');
    expect(impacts(hidden)).not.toContain('neutral');
    expect(impacts(hidden)).toContain(null);
  });

  it('a second Refresh finds nothing new to judge and spends nothing more', async () => {
    const before = executor.prompts.length;
    await t.post('/api/news/refresh');
    await t.app.services.news.idle();
    expect(executor.prompts.length).toBe(before);
  });

  it('exposes the job ports the scheduler uses: auto follows the config, and classify judges on demand', async () => {
    const ports = t.app.services.news.jobPorts();
    expect(ports.auto).toBe(true);
    expect(ports.classify).toBeTypeOf('function');
    expect(await ports.classify?.()).toMatchObject({ rows: 0, failed: false });
  });
});

describe('when the model must not run', () => {
  it('OT_AI_AUTO=off keeps the schedule from judging but Refresh still does', async () => {
    const w = await world();
    const executor = new FakeExecutor({ steps: 0, reply: scripted });
    const t = await startApp(w.db, {
      tmp: w.tmp,
      fetch: w.replay.fetch,
      now: NEWS_NOW,
      executor,
      news: { auto: false },
    });
    try {
      expect(t.app.services.news.jobPorts().auto).toBe(false);
      expect((await t.get('/api/news?scope=all&days=3')).json.status.ai).toMatchObject({
        available: true,
        auto: false,
      });
      expect(executor.prompts).toHaveLength(0);
      await t.post('/api/news/refresh');
      await t.app.services.news.idle();
      expect(executor.prompts.length).toBeGreaterThan(0);
    } finally {
      await t.close();
      await drop(w);
    }
  });

  it('a daily budget below one call judges nothing and the page says how many stories wait', async () => {
    const w = await world();
    const executor = new FakeExecutor({ steps: 0, reply: scripted });
    const t = await startApp(w.db, {
      tmp: w.tmp,
      fetch: w.replay.fetch,
      now: NEWS_NOW,
      executor,
      news: { dailyBudgetUsd: 0.03 },
    });
    try {
      await t.post('/api/news/refresh');
      await t.app.services.news.idle();
      expect(executor.prompts).toHaveLength(0);
      const r = await t.get('/api/news?scope=all&days=3');
      expect(r.json.status.unclassified).toBeGreaterThan(5);
      expect(r.json.status.ai.spentTodayUsd).toBe(0);
      expect(
        r.json.groups
          .flatMap((g: { items: { impact: unknown }[] }) => g.items)
          .every((i: { impact: unknown }) => i.impact === null),
      ).toBe(true);
    } finally {
      await t.close();
      await drop(w);
    }
  });

  it('the demo fake executor cannot write a judgement, so news is not judged and not marked rejected', async () => {
    const w = await world();
    const executor = new FakeExecutor({ steps: 0 });
    const t = await startApp(w.db, { tmp: w.tmp, fetch: w.replay.fetch, now: NEWS_NOW, executor });
    try {
      expect((await t.get('/api/news?scope=all&days=3')).json.status.ai.available).toBe(false);
      await t.post('/api/news/refresh');
      await t.app.services.news.idle();
      expect(executor.prompts).toHaveLength(0);
      const rows = await w.db.db.select().from(newsItems);
      expect(rows.length).toBeGreaterThan(5);
      expect(rows.every((r) => r.aiKnownAt === null)).toBe(true);
      expect(t.app.services.news.jobPorts().auto).toBe(false);
    } finally {
      await t.close();
      await drop(w);
    }
  });
});
