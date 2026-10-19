import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reason } from '../../src/core/types';
import { createResearchRun, updateResearchRun } from '../../src/db/app-repos';
import type { Db } from '../../src/db/client';
import { insertPosition, loadParams } from '../../src/db/repos';
import { ivDaily, recommendations, researchRuns, scanRuns } from '../../src/db/schema';
import type { AskItemView, AskThreadView } from '../../src/server/api-types';
import type { ExecInput, ExecResult, SkillExecutor } from '../../src/server/research/executor';
import { startApp, type TestApp } from '../helpers/app';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

const NOW = new Date('2026-10-19T02:00:00Z'); // 10:00 HKT

/** An executor that answers from a function, can hang until cancelled, and remembers what it was asked. */
class Scripted implements SkillExecutor {
  readonly kind = 'fake' as const;
  readonly inputs: ExecInput[] = [];
  reply: (prompt: string) => string = () =>
    '**Short answer:** the numbers support the sale; `vol.vrpForward` is unmeasured, so pitfall 36 calls the edge unproven.';
  mode: 'answer' | 'hang' | 'throw' = 'answer';

  run(i: ExecInput): Promise<ExecResult> {
    this.inputs.push(i);
    if (this.mode === 'throw') return Promise.reject(new Error('claude exited with code 1: simulated failure'));
    if (this.mode === 'hang')
      return new Promise((_resolve, reject) => {
        i.onProgress('thinking');
        i.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    i.onProgress('writing');
    return Promise.resolve({ markdown: this.reply(i.prompt), costUsd: 0.0312, model: 'fake-sonnet' });
  }
}

const REASONS: Reason[] = [
  { rule: 'vol.vrpForward', value: 'unmeasured', passed: true, level: 'INFO', note: 'fewer than ten aligned windows' },
  { rule: 'vol.ivRank', value: 72, threshold: '>= 30', passed: true, level: 'PASS' },
  { rule: 'option.lossProbIv', value: 0.25, passed: true, level: 'INFO' },
  { rule: 'option.lossProbRv', value: 0.205, passed: true, level: 'INFO' },
];

async function seedRecommendation(db: Db, instrumentId: number, asOf: string): Promise<void> {
  const { id: paramsId } = await loadParams(db);
  const [run] = await db
    .insert(scanRuns)
    .values({ asOf, paramsId, mode: 'live', status: 'done', startedAt: NOW, finishedAt: NOW })
    .returning({ id: scanRuns.id });
  await db.insert(recommendations).values({
    scanRunId: (run as { id: string }).id,
    instrumentId,
    asOf,
    rank: 1,
    underlyingPrice: '200',
    strike: '180',
    expiry: '2026-11-20',
    dte: 32,
    creditPerContract: '320',
    collateralPerContract: '18000',
    collateralBaseCcy: '18000',
    roc: '0.0178',
    annualizedRoc: '0.203',
    breakeven: '176.8',
    cushionPct: '0.099',
    probItm: '0.25',
    composite: '74',
    reasons: REASONS,
    dataTier: 'real',
  });
}

let db: TestDb;
let tmp: string;
let t: TestApp;
let ex: Scripted;
let snowId: number;
let positionId: number;

const settle = () => t.app.services.ask.idle();

beforeAll(async () => {
  db = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'ot-ask-'));
  const snow = await seedInstrument(db.db, 'US', 'SNOW', { name: 'Snowflake' });
  snowId = snow.id;
  const tencent = await seedInstrument(db.db, 'HK', '0700', { name: 'Tencent', boardLot: 100 });
  await seedInstrument(db.db, 'US', 'NKE', { name: 'Nike' });
  await seedRecommendation(db.db, snow.id, '2026-10-16');
  await seedRecommendation(db.db, tencent.id, '2026-10-16');
  await db.db.insert(ivDaily).values({
    instrumentId: snow.id,
    day: '2026-10-16',
    iv30: '0.558',
    iv60: '0.53',
    ivRank: '72',
    ivPercentile: '80.5',
    rv20: '0.473',
    rv60: '0.5',
    skew25d: '0.05',
    termRatio: '0.95',
    tier: 'real',
  });
  positionId = (await insertPosition(db.db, {
    instrumentId: tencent.id,
    strike: 560,
    expiry: '2026-11-27',
    multiplier: 100,
    quantity: 1,
    openDate: '2026-10-10',
    openPrice: 8.5,
  })) as number;
  ex = new Scripted();
  t = await startApp(db, { tmp, now: NOW, executor: ex, ask: { dailyBudgetUsd: 1, timeoutMs: 1500 } });
});

afterAll(async () => {
  await t.close();
  rmSync(tmp, { recursive: true, force: true });
  await db.drop();
});

describe('POST /api/ask on an idea', () => {
  let first: AskItemView;

  it('queues a research_runs row of kind ask and answers it from the stored idea with the matched pitfalls', async () => {
    const r = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'SNOW' },
      question: 'Should I sell this put? IV looks high',
    });
    expect(r.status).toBe(202);
    const started = r.json as AskItemView;
    expect(started).toMatchObject({ status: 'queued', symbol: 'SNOW', market: 'US', answer: null });
    await settle();
    const g = await t.get(`/api/ask/${started.id}`);
    expect(g.status).toBe(200);
    first = g.json as AskItemView;
    expect(first.status).toBe('done');
    expect(first.answer).toMatch(/^\*\*Short answer:\*\*/);
    expect(first.pitfalls).toEqual([36, 19, 7, 21]);
    expect(first.costUsd).toBeCloseTo(0.0312, 4);
    expect(first.model).toBe('fake-sonnet');
    expect(first.grounding).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/stored idea of 2026-10-16, 4 reasons/),
        'IV row 2026-10-16',
        'no thesis note',
        'no news brief today',
      ]),
    );
    const [row] = await db.db.select().from(researchRuns).where(eq(researchRuns.id, started.id));
    expect(row?.skillId).toBe('ask');
    expect(row?.status).toBe('done');
    expect(row?.costUsd).toBe('0.0312');
    expect(row?.reportPath).toBeNull();
  });

  it('grounded the prompt in the Reasons JSON and the IV row, with no tools and the per-answer cap', () => {
    const input = ex.inputs[0] as ExecInput;
    const p = input.prompt;
    expect(p).toContain('=== RULES ===');
    expect(p).toContain('"rule":"vol.vrpForward"');
    expect(p).toContain('"rule":"option.lossProbRv"');
    expect(p).toContain('IV30 0.558');
    expect(p).toContain('the 2026-11-20 180 put');
    expect(p).toContain('--- pitfall 36:');
    expect(p).toContain('--- pitfall 21:');
    expect(p).not.toContain('--- pitfall 13:');
    expect(p).not.toContain('HONG KONG NOTES');
    expect(p).toMatch(/Should I sell this put\? IV looks high\s*$/m);
    expect(input.tools).toEqual([]);
    expect(input.allowedTools).toEqual([]);
    expect(input.isolated).toBe(true);
    expect(input.maxBudgetUsd).toBe(0.25);
    expect(input.model).toBe('claude-sonnet-5-5');
  });

  it('lists the thread oldest first and feeds earlier turns to the next question', async () => {
    const r = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'snow' },
      question: 'But the rank is 72, is that not enough?',
    });
    expect(r.status).toBe(202);
    await settle();
    const thread = (await t.get('/api/ask?kind=idea&market=US&symbol=SNOW')).json as AskThreadView;
    expect(thread.symbol).toBe('SNOW');
    expect(thread.name).toBe('Snowflake');
    expect(thread.executor).toBe('fake');
    expect(thread.items.map((i) => i.question)).toEqual([
      'Should I sell this put? IV looks high',
      'But the rank is 72, is that not enough?',
    ]);
    expect(thread.items.every((i) => i.status === 'done')).toBe(true);
    expect(thread.limits).toMatchObject({ perRunUsd: 0.25, dailyUsd: 1, runsToday: 2 });
    expect(thread.limits.spentTodayUsd).toBeCloseTo(0.0624, 4);
    const second = (ex.inputs[1] as ExecInput).prompt;
    expect(second).toContain('=== THREAD');
    expect(second).toContain('Q: Should I sell this put? IV looks high');
    expect(second).toContain(`A: ${first.answer}`);
  });

  it('keeps Ask rows out of the Research page list', async () => {
    const runs = (await t.get('/api/research/runs?market=US&symbol=SNOW')).json as { skillId: string }[];
    expect(runs.filter((r) => r.skillId === 'ask')).toEqual([]);
  });
});

describe('POST /api/ask on a position', () => {
  it('grounds the prompt in the put, adds the Hong Kong notes and defaults to the management pitfalls', async () => {
    const before = ex.inputs.length;
    const r = await t.post('/api/ask', { target: { kind: 'position', positionId }, question: 'What now?' });
    expect(r.status).toBe(202);
    await settle();
    const item = (await t.get(`/api/ask/${(r.json as AskItemView).id}`)).json as AskItemView;
    expect(item.status).toBe('done');
    expect(item.pitfalls).toEqual([13, 4]);
    expect(item.symbol).toBe('0700');
    const p = (ex.inputs[before] as ExecInput).prompt;
    expect(p).toContain('Open put: 0700 (HK, Tencent), 1 x the 2026-11-27 560 put sold on 2026-10-10');
    expect(p).toContain('### The position');
    expect(p).toContain('multiplier 100');
    expect(p).toContain('=== HONG KONG NOTES ===');
    expect(p).toMatch(/board lot/);
    expect(p).toContain('--- pitfall 13:');
    expect(p).toContain('--- pitfall 4:');
    expect(p).not.toContain('--- pitfall 36:');
    expect(p).toContain('### Open puts on this name (with the latest marks)');
    expect(p).toMatch(/Reasons JSON from the stored scan of 2026-10-16/);
    const thread = (await t.get(`/api/ask?kind=position&positionId=${positionId}`)).json as AskThreadView;
    expect(thread.items.map((i) => i.question)).toEqual(['What now?']);
  });
});

describe('validation and limits', () => {
  it('rejects an empty or oversized question, an unknown stock, a missing position and a bad kind', async () => {
    const empty = await t.post('/api/ask', { target: { kind: 'idea', market: 'US', symbol: 'SNOW' }, question: '  ' });
    expect(empty.status).toBe(400);
    expect((empty.json as { error: { code: string } }).error.code).toBe('question_required');
    const long = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'SNOW' },
      question: 'x'.repeat(601),
    });
    expect(long.status).toBe(400);
    const unknown = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'ZZZZ' },
      question: 'hi?',
    });
    expect(unknown.status).toBe(400);
    expect((unknown.json as { error: { code: string } }).error.code).toBe('unknown_stock');
    const missing = await t.post('/api/ask', { target: { kind: 'position', positionId: 9999 }, question: 'hi?' });
    expect(missing.status).toBe(404);
    expect((await t.get('/api/ask?kind=nope')).status).toBe(400);
    expect((await t.get('/api/ask/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('fails the run, not the request, when the name has no idea yet', async () => {
    const r = await t.post('/api/ask', { target: { kind: 'idea', market: 'US', symbol: 'NKE' }, question: 'Why?' });
    expect(r.status).toBe(202);
    await settle();
    const item = (await t.get(`/api/ask/${(r.json as AskItemView).id}`)).json as AskItemView;
    expect(item.status).toBe('failed');
    expect(item.error).toMatch(/no idea for NKE/);
  });

  it('allows one question at a time per target and fails a run that outlives the timeout', async () => {
    ex.mode = 'hang';
    const r = await t.post('/api/ask', { target: { kind: 'idea', market: 'US', symbol: 'SNOW' }, question: 'Slow?' });
    expect(r.status).toBe(202);
    const again = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'SNOW' },
      question: 'Hello?',
    });
    expect(again.status).toBe(409);
    expect((again.json as { error: { code: string } }).error.code).toBe('ask_in_progress');
    await settle();
    ex.mode = 'answer';
    const item = (await t.get(`/api/ask/${(r.json as AskItemView).id}`)).json as AskItemView;
    expect(item.status).toBe('failed');
    expect(item.error).toMatch(/did not answer within 2 seconds/);
  });

  it('takes a fenced answer out of its fence and refuses HTML or a crash with a reason', async () => {
    const ask = async (question: string): Promise<AskItemView> => {
      const r = await t.post('/api/ask', { target: { kind: 'idea', market: 'US', symbol: 'SNOW' }, question });
      expect(r.status).toBe(202);
      await settle();
      return (await t.get(`/api/ask/${(r.json as AskItemView).id}`)).json as AskItemView;
    };
    ex.reply = () => '```markdown\n**Short answer:** yes, the cushion of 9.9% holds at realised vol.\n```';
    expect((await ask('Fenced?')).answer).toBe('**Short answer:** yes, the cushion of 9.9% holds at realised vol.');
    ex.reply = () => '<p>Short answer: yes, the cushion of 9.9% holds at realised vol.</p>';
    const html = await ask('Html?');
    expect(html.status).toBe('failed');
    expect(html.error).toMatch(/contained HTML/);
    ex.mode = 'throw';
    const crashed = await ask('Crash?');
    expect(crashed.status).toBe('failed');
    expect(crashed.error).toMatch(/simulated failure/);
    ex.mode = 'answer';
  });

  it('refuses a new question once the Hong Kong day budget is spent', async () => {
    const row = await createResearchRun(db.db, snowId, 'ask');
    await updateResearchRun(db.db, row.id, {
      status: 'done',
      costUsd: 0.9,
      result: { kind: 'ask', target: { kind: 'idea', market: 'US', symbol: 'SNOW' }, question: 'old', answer: 'x' },
    });
    const r = await t.post('/api/ask', {
      target: { kind: 'idea', market: 'US', symbol: 'SNOW' },
      question: 'One more?',
    });
    expect(r.status).toBe(429);
    expect((r.json as { error: { code: string; message: string } }).error.code).toBe('daily_budget');
    expect((r.json as { error: { message: string } }).error.message).toMatch(/midnight Hong Kong time/);
    await updateResearchRun(db.db, row.id, { costUsd: 0 });
    expect(
      (await t.post('/api/ask', { target: { kind: 'idea', market: 'US', symbol: 'SNOW' }, question: 'Ok?' })).status,
    ).toBe(202);
    await settle();
  });
});
