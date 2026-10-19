import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResearchRunDetailView, ResearchRunView, SkillCatalogView } from '../../src/server/api-types';
import { FakeExecutor } from '../../src/server/research/executor';
import { startApp, type TestApp } from '../helpers/app';
import { bootstrap, withDbs } from './harness';

const { fresh, tmp } = withDbs();

async function waitRuns(t: TestApp, symbol: string, market = 'US', timeoutMs = 20_000): Promise<ResearchRunView[]> {
  const started = Date.now();
  for (;;) {
    const runs = (await t.get(`/api/research/runs?market=${market}&symbol=${symbol}`)).json as ResearchRunView[];
    if (runs.length > 0 && runs.every((r) => !['queued', 'running'].includes(r.status))) return runs;
    if (Date.now() - started > timeoutMs)
      throw new Error(`runs did not finish: ${JSON.stringify(runs.map((r) => r.status))}`);
    await new Promise((res) => setTimeout(res, 40));
  }
}

describe('app e2e 3: the research runner (quality screen locally, AI skills through the executor)', () => {
  let t: TestApp;
  let executor: FakeExecutor;
  let dbHandle: Awaited<ReturnType<typeof fresh>>;

  beforeAll(async () => {
    dbHandle = await fresh();
    await bootstrap(dbHandle);
    executor = new FakeExecutor({ steps: 3, delayMs: 15 });
    t = await startApp(dbHandle, { tmp: tmp(), executor });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists the seven skills, four presets and what is available', async () => {
    const c = (await t.get('/api/skills')).json as SkillCatalogView;
    expect(c.skills.map((s) => s.id)).toEqual([
      'quality-screen',
      'investment-checklist',
      'investment-research',
      'earnings-review',
      'management-deep-dive',
      'news-pulse',
      'thesis-tracker',
    ]);
    expect(c.presets.map((p) => p.id)).toEqual(['assign', 'numbers', 'full', 'leader']);
    expect(c.presets.find((p) => p.id === 'assign')?.skillIds).toEqual([
      'quality-screen',
      'investment-checklist',
      'thesis-tracker',
      'news-pulse',
    ]);
    expect(c.executor).toBe('fake');
    expect(c.skills.every((s) => s.available)).toBe(true);
    expect(c.skills.find((s) => s.id === 'quality-screen')).toMatchObject({ local: true, effort: 'local' });
    expect(c.skills.find((s) => s.id === 'investment-research')?.effort).toBe('heavy');
    expect(c.skills.every((s) => s.steps.length >= 2 && s.zhName && s.enName)).toBe(true);
  });

  it('marks AI skills unavailable when the skill files are missing, and refuses to start them', async () => {
    const bare = await startApp(dbHandle, { tmp: tmp(), withSkillFiles: false });
    const c = (await bare.get('/api/skills')).json as SkillCatalogView;
    expect(c.skills.find((s) => s.id === 'quality-screen')?.available).toBe(true);
    const ai = c.skills.find((s) => s.id === 'news-pulse');
    expect(ai?.available).toBe(false);
    expect(ai?.unavailableReason).toMatch(/skill file not found/);
    const r = await bare.post('/api/research/runs', { symbol: 'AAPL', market: 'US', skillIds: ['news-pulse'] });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('skill_unavailable');
    await bare.close();
  });

  it('validates the request', async () => {
    expect((await t.post('/api/research/runs', { symbol: 'AAPL', skillIds: [] })).json.error.code).toBe('validation');
    expect((await t.post('/api/research/runs', { symbol: 'AAPL', skillIds: ['nonsense'] })).json.error.code).toBe(
      'validation',
    );
    expect(
      (await t.post('/api/research/runs', { symbol: 'NOPE', market: 'US', skillIds: ['quality-screen'] })).json.error
        .code,
    ).toBe('unknown_stock');
    expect((await t.get('/api/research/runs/not-a-uuid')).status).toBe(404);
    expect((await t.get('/api/research/runs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('runs the quality screen locally and two AI skills, saving reports on disk', async () => {
    const start = await t.post('/api/research/runs', {
      symbol: 'AAPL',
      market: 'US',
      skillIds: ['quality-screen', 'investment-checklist', 'thesis-tracker'],
    });
    expect(start.status).toBe(202);
    expect((start.json as ResearchRunView[]).map((r) => r.skillId)).toEqual([
      'quality-screen',
      'investment-checklist',
      'thesis-tracker',
    ]);
    expect((start.json as ResearchRunView[]).every((r) => ['queued', 'running'].includes(r.status))).toBe(true);
    const runs = await waitRuns(t, 'AAPL');
    expect(runs.map((r) => r.status)).toEqual(['done', 'done', 'done']);

    const screen = runs.find((r) => r.skillId === 'quality-screen') as ResearchRunView;
    const sd = (await t.get(`/api/research/runs/${screen.id}`)).json as ResearchRunDetailView;
    expect(sd.report?.format).toBe('screen');
    if (sd.report?.format === 'screen') expect(sd.report.screen.rows).toHaveLength(7);
    const smd = (await t.get(`/api/research/runs/${screen.id}/report.md`)).text;
    expect(smd).toMatch(/^<!-- quality-screen for US:AAPL/);
    expect(smd).toMatch(/\| 1 \| 10-year average ROE/);

    const ai = runs.find((r) => r.skillId === 'investment-checklist') as ResearchRunView;
    expect(ai).toMatchObject({ costUsd: 0.01, model: 'fake-model', hasReport: true, error: null });
    expect(ai.steps.length).toBeGreaterThan(5);
    expect(ai.progress.length).toBeGreaterThanOrEqual(3);
    const ad = (await t.get(`/api/research/runs/${ai.id}`)).json as ResearchRunDetailView;
    expect(ad.report?.format).toBe('markdown');
    if (ad.report?.format === 'markdown') {
      expect(ad.report.markdown).toMatch(/# Fake report/);
      expect(ad.report.markdown).toMatch(/not investment advice/);
    }
    const files = readdirSync(join(t.reportsDir, 'US-AAPL')).sort();
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.replace(/-\d{8}-\d{6}Z\.md$/, ''))).toEqual([
      'investment-checklist',
      'quality-screen',
      'thesis-tracker',
    ]);
    expect(readFileSync(join(t.reportsDir, 'US-AAPL', files[0] as string), 'utf8')).toMatch(
      /Fake report|Quality screen/,
    );
  });

  it('runs AI skills with read-only tools and only the exact-decimal helper scripts allowed', async () => {
    const input = executor.inputs.find((i) =>
      i.prompt.includes('Buffett checklist'),
    ) as (typeof executor.inputs)[number];
    expect(input.tools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Bash']);
    expect(input.tools.join(',')).not.toMatch(/Write|Edit|NotebookEdit/);
    expect(input.allowedTools).toEqual([
      'WebSearch',
      'WebFetch',
      'Read',
      'Bash(*python.exe*financial_rigor.py*)',
      'Bash(*python.exe*report_audit.py*)',
    ]);
    expect(input.maxBudgetUsd).toBe(1);
    expect(input.cwd).toBe(t.root);
  });

  it('builds the prompt from the skill file: target, tool root and python substituted, write access forbidden', async () => {
    const prompt = executor.prompts.find((p) => p.includes('Buffett checklist')) as string;
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain('$ARGUMENTS');
    expect(prompt).not.toContain('~/ai-berkshire');
    expect(prompt).toContain('Analyse Apple Inc. (AAPL, US).');
    expect(prompt).toContain(`${t.root.replace(/\\/g, '/')}/tools/financial_rigor.py`);
    expect(prompt).toContain('"C:/Python/python.exe" ');
    expect(prompt).toMatch(/Do not create, edit or save any file/);
    expect(prompt).toMatch(/Facts from the user's own database/);
    expect(prompt).toMatch(/quality screen on stored data: (PASS|EXEMPT-PASS|EXCLUDED|INCOMPLETE)/);
    expect(prompt).not.toMatch(/postgres|password/i);
  });

  it('a stock without stored statements fails the local screen with a clear message', async () => {
    expect((await t.post('/api/watchlist', { symbol: 'KO' })).status).toBe(201);
    await t.post('/api/research/runs', { symbol: 'KO', market: 'US', skillIds: ['quality-screen'] });
    const runs = await waitRuns(t, 'KO');
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0]?.error).toMatch(/no stored financial statements/);
    expect((await t.get(`/api/research/runs/${runs[0]?.id}/report.md`)).status).toBe(404);
  });

  it('a failing executor marks the run failed with its message, never done', async () => {
    const failing = await startApp(dbHandle, { tmp: tmp(), executor: new FakeExecutor({ failWhen: () => true }) });
    await failing.post('/api/research/runs', { symbol: '0700', market: 'HK', skillIds: ['news-pulse'] });
    const runs = await waitRuns(failing, '0700', 'HK');
    expect(runs[0]).toMatchObject({ status: 'failed', hasReport: false });
    expect(runs[0]?.error).toMatch(/told to fail/);
    await failing.close();
  });

  it('HK targets carry the .HK symbol and the exchange', async () => {
    await t.post('/api/research/runs', { symbol: '0700', market: 'HK', skillIds: ['management-deep-dive'] });
    await waitRuns(t, '0700', 'HK');
    const prompt = executor.prompts.find((p) => p.includes('Management deep dive')) as string;
    expect(prompt).toMatch(/Analyse .*\(0700\.HK, HKEX\)\./);
  });

  it('cancels a running run and a queued run', async () => {
    const slow = await startApp(dbHandle, { tmp: tmp(), executor: new FakeExecutor({ steps: 200, delayMs: 25 }) });
    await slow.post('/api/research/runs', {
      symbol: 'MSFT',
      market: 'US',
      skillIds: ['news-pulse', 'thesis-tracker', 'earnings-review'],
    });
    let runs: ResearchRunView[] = [];
    for (let i = 0; i < 100 && runs.filter((r) => r.status === 'running').length < 2; i++) {
      await new Promise((res) => setTimeout(res, 30));
      runs = (await slow.get('/api/research/runs?market=US&symbol=MSFT')).json as ResearchRunView[];
    }
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(2);
    const queued = runs.find((r) => r.status === 'queued') as ResearchRunView;
    expect(queued).toBeTruthy();
    const c1 = await slow.post(`/api/research/runs/${queued.id}/cancel`);
    expect(c1.json.status).toBe('cancelled');
    for (const r of runs.filter((x) => x.status === 'running')) {
      await slow.post(`/api/research/runs/${r.id}/cancel`);
    }
    const final = await waitRuns(slow, 'MSFT');
    expect(final.map((r) => r.status).sort()).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(final.every((r) => !r.hasReport)).toBe(true);
    await slow.close();
  });

  it('a run left running by a dead server is failed on the next start, and report paths cannot escape the reports folder', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const inst = (await dbHandle.db.execute(sql`select id from instruments where symbol = 'AAPL'`)).rows[0] as {
      id: number;
    };
    await dbHandle.db.execute(
      sql`insert into research_runs (id, instrument_id, skill_id, status) values (${id}, ${inst.id}, 'news-pulse', 'running')`,
    );
    const evil = '22222222-2222-4222-8222-222222222222';
    await dbHandle.db.execute(
      sql`insert into research_runs (id, instrument_id, skill_id, status, report_path) values (${evil}, ${inst.id}, 'news-pulse', 'done', '../../.env')`,
    );
    const again = await startApp(dbHandle, { tmp: tmp() });
    const r = (await again.get(`/api/research/runs/${id}`)).json as ResearchRunDetailView;
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/server restarted/);
    const e = await again.get(`/api/research/runs/${evil}/report.md`);
    expect(e.status).toBe(400);
    expect(e.json.error.code).toBe('bad_path');
    await again.close();
  });
});
