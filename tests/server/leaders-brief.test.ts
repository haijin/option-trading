import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRun, listCandidates } from '../../src/db/leaders';
import { runLeadersBriefJob } from '../../src/jobs/jobs';
import { runLeadersScan } from '../../src/jobs/leaders-scan';
import { buildLeadersBriefInput, buildLeadersBriefPrompt, parseLeadersBrief } from '../../src/server/leaders/brief';
import { FakeExecutor } from '../../src/server/research/executor';
import { startApp, type TestApp } from '../helpers/app';
import { END } from '../helpers/history';
import { seedLeadersWorld } from '../helpers/leaders-world';
import { createTestDb, type TestDb } from '../helpers/test-db';

const NOW = new Date('2026-10-10T00:00:00Z');

describe('the brief validator', () => {
  const input = 'Names: [12] VRT · Setup · score 91 · 3m +71% · base 14% deep over 19 days · stop 2.4% · 3R 183.2';
  const ids = new Set([12, 37]);
  const ok = (extra = '') =>
    `Here you go.\n\`\`\`json\n{"lead":"Bull market, one Setup on the list.","lines":{"12":"Turned up off its base; the stop is 2.4%.${extra}"}}\n\`\`\``;

  it('accepts one fenced json block whose numbers are all in the input', () => {
    const r = parseLeadersBrief(ok(), input, ids);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lead).toMatch(/^Bull market/);
      expect([...r.lines]).toEqual([[12, 'Turned up off its base; the stop is 2.4%.']]);
    }
  });

  it('rejects a missing or doubled block, bad json, a bad shape and an extra key', () => {
    expect(parseLeadersBrief('no block here', input, ids)).toEqual({
      ok: false,
      reason: 'no json block in the answer',
    });
    expect(parseLeadersBrief(`${ok()}\n${ok()}`, input, ids)).toEqual({
      ok: false,
      reason: 'more than one json block in the answer',
    });
    expect(parseLeadersBrief('```json\n{nope\n```', input, ids)).toEqual({
      ok: false,
      reason: 'the json block does not parse',
    });
    expect(
      (parseLeadersBrief('```json\n{"lead":"","lines":{}}\n```', input, ids) as { reason: string }).reason,
    ).toMatch(/^schema: lead/);
    expect(
      (parseLeadersBrief('```json\n{"lead":"x","lines":{},"extra":1}\n```', input, ids) as { reason: string }).reason,
    ).toMatch(/^schema:/);
    expect(
      (
        parseLeadersBrief(`\`\`\`json\n{"lead":"${'x'.repeat(301)}","lines":{}}\n\`\`\``, input, ids) as {
          reason: string;
        }
      ).reason,
    ).toMatch(/^schema: lead/);
    expect(
      (
        parseLeadersBrief(`\`\`\`json\n{"lead":"x","lines":{"12":"${'y'.repeat(161)}"}}\n\`\`\``, input, ids) as {
          reason: string;
        }
      ).reason,
    ).toMatch(/^schema: lines/);
  });

  it('rejects an id that is not a name in the input, a link, and any number the input does not carry', () => {
    expect(
      (parseLeadersBrief('```json\n{"lead":"x","lines":{"99":"y"}}\n```', input, ids) as { reason: string }).reason,
    ).toBe('a line for 99, which is not a name in the input');
    expect((parseLeadersBrief(ok(' See https://example.com'), input, ids) as { reason: string }).reason).toBe(
      'a link in the text',
    );
    expect((parseLeadersBrief(ok(' It could reach 250.'), input, ids) as { reason: string }).reason).toBe(
      'introduces the number 250, which is not in the input',
    );
    // 183.2 is in the input, however it is written
    expect(parseLeadersBrief(ok(' The 3R level is 183.20.'), input, ids).ok).toBe(true);
    expect(parseLeadersBrief(ok(' The 3R level is 183.2.'), input, ids).ok).toBe(true);
  });
});

describe('the brief of a run', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  let runId = 0;
  let setupInstrument = 0;
  let setupCandidate = 0;
  const executor = new FakeExecutor({
    reply: (prompt) => {
      const stop = /stop (\d+\.\d)%/.exec(prompt)?.[1] ?? '2';
      const id = /\[(\d+)\] Setup Corp/.exec(prompt)?.[1] ?? '0';
      return {
        markdown: `\`\`\`json\n${JSON.stringify({
          lead: 'A calm bull market; the list holds one Setup and one Watch name.',
          lines: { [id]: `Turned up off its base; the plan shows a ${stop}% stop and no earnings date is known.` },
        })}\n\`\`\``,
        costUsd: 0.02,
        model: 'claude-haiku-5-5',
      };
    },
  });

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-lbrief-'));
    await seedLeadersWorld(db.db);
    t = await startApp(db, { tmp, now: NOW, executor });
    const out = await runLeadersScan({ db: db.db, now: () => NOW, log: () => {} }, { market: 'US', asOf: END });
    runId = out.runId;
    const rows = await listCandidates(db.db, [runId]);
    const s = rows.find((r) => r.symbol === 'LEAD1');
    setupInstrument = s?.instrumentId as number;
    setupCandidate = s?.id as number;
  });
  afterAll(async () => {
    await t.close();
    rmSync(tmp, { recursive: true, force: true });
    await db.drop();
  });

  it('the input carries the regime, the funnel, the names with their reason lines, and the page shows nothing before the brief', async () => {
    const run = (await getRun(db.db, runId)) as NonNullable<Awaited<ReturnType<typeof getRun>>>;
    const rows = (await listCandidates(db.db, [runId])).filter((r) => r.rank !== null);
    const input = buildLeadersBriefInput({ run, rows, today: '2026-10-10' });
    expect(input).toContain('Market: US. Session of 2026-10-09.');
    expect(input).toContain('regime bull_calm');
    expect(input).toContain('Funnel: 63 screened, 3 leaders, 2 in a valid base, 2 on the list (1 Setup, 1 Watch).');
    expect(input).toContain(`[${setupInstrument}] Setup Corp · LEAD1 · Setup`);
    expect(input).toMatch(/Turn-up bar: closed in the top third/);
    expect(buildLeadersBriefPrompt(input)).toContain('=== INPUT ===');
    expect(buildLeadersBriefPrompt(input)).not.toContain('{{INPUT}}');
    const view = (await t.get('/api/leaders')).json;
    expect(view.brief).toBeNull();
    expect(view.candidates.every((c: { brief: string | null }) => c.brief === null)).toBe(true);
  });

  it('one no-tools call writes the lead and the line; the page shows them; a second call does nothing', async () => {
    const out = await t.app.services.leaders.brief([runId]);
    expect(out).toMatchObject({ rows: 1, failed: false });
    expect(out.detail).toMatch(/^US 2026-10-09 brief written: a lead and 1 line, US\$0\.02/);
    const call = executor.inputs.at(-1);
    expect(call).toMatchObject({
      tools: [],
      allowedTools: [],
      model: 'claude-haiku-5-5',
      maxBudgetUsd: 0.1,
      isolated: true,
    });
    const run = await getRun(db.db, runId);
    expect(run?.briefLead).toMatch(/^A calm bull market/);
    expect(run?.briefModel).toBe('claude-haiku-5-5');
    expect(Number(run?.briefCostUsd)).toBeCloseTo(0.02, 4);
    const view = (await t.get('/api/leaders')).json;
    expect(view.brief).toEqual({ lead: run?.briefLead, model: 'claude-haiku-5-5' });
    const setup = view.candidates.find((c: { id: number }) => c.id === setupCandidate);
    expect(setup.brief).toMatch(/^Turned up off its base; the plan shows a \d\.\d% stop/);
    expect(view.candidates.find((c: { symbol: string }) => c.symbol === 'LEAD2').brief).toBeNull();
    const calls = executor.prompts.length;
    expect((await t.app.services.leaders.brief([runId])).detail).toMatch(/already written/);
    expect(executor.prompts.length).toBe(calls);
  });

  it('is a job step too: skipped when the schedule must not call the model, run when it may', async () => {
    const run2 = await runLeadersScan({ db: db.db, now: () => NOW, log: () => {} }, { market: 'US', asOf: END });
    const deps = (auto: boolean) => ({
      ctx: { db: () => ({ db: db.db }) } as never,
      notifier: null,
      log: () => {},
      leaders: { auto, brief: (ids: number[]) => t.app.services.leaders.brief(ids) },
    });
    expect(await runLeadersBriefJob(deps(false) as never, [run2.runId], { scheduled: true })).toMatchObject({
      status: 'ok',
      rows: 0,
      detail: expect.stringMatching(/automatic briefs are off/),
    });
    expect(await runLeadersBriefJob({ ...deps(true), leaders: undefined } as never, [run2.runId])).toMatchObject({
      detail: expect.stringMatching(/no model attached/),
    });
    expect(await runLeadersBriefJob(deps(true) as never, [], { scheduled: true })).toMatchObject({
      detail: 'no run to write a brief for',
    });
  });
});

describe('a rejected brief is dropped and the page keeps the skill reason lines', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  let runId = 0;
  let bad = 0;
  const executor = new FakeExecutor({
    reply: () => {
      bad++;
      return {
        markdown: '```json\n{"lead":"The list targets 4321 as a floor.","lines":{}}\n```',
        costUsd: 0.03,
      };
    },
  });

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-lbrief2-'));
    await seedLeadersWorld(db.db);
    t = await startApp(db, { tmp, now: NOW, executor, leaders: { dailyBudgetUsd: 0.15 } });
    runId = (await runLeadersScan({ db: db.db, now: () => NOW, log: () => {} }, { market: 'US', asOf: END })).runId;
  });
  afterAll(async () => {
    await t.close();
    rmSync(tmp, { recursive: true, force: true });
    await db.drop();
  });

  it('retries once with the reason, then drops it: nothing is stored, the cost still counts against the day', async () => {
    const out = await t.app.services.leaders.brief([runId]);
    expect(out.failed).toBe(true);
    expect(out.rows).toBe(0);
    expect(out.detail).toMatch(/rejected by the validators: introduces the number 4321, which is not in the input/);
    expect(bad).toBe(2);
    expect(executor.prompts[1]).toMatch(/Your previous answer was rejected: introduces the number 4321/);
    const run = await getRun(db.db, runId);
    expect(run?.briefLead).toBeNull();
    const view = (await t.get('/api/leaders')).json;
    expect(view.brief).toBeNull();
    expect(view.candidates[0].why).toHaveLength(3);
    expect(view.candidates[0].brief).toBeNull();
    // 0.06 went on the two rejected answers, so 0.09 is left of 0.15 and one more brief (cap 0.10) is not covered
    const again = await t.app.services.leaders.brief([runId]);
    expect(bad).toBe(2);
    expect(again.detail).toMatch(/cannot cover a brief/);
  });
});
