import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalAiRuns, journalEntries } from '../../src/db/schema';
import type { JournalDocJson } from '../../src/journal';
import { type ExecInput, type ExecResult, FakeExecutor, type SkillExecutor } from '../../src/server/research/executor';
import { stableJson } from '../../src/server/services/journal-service';
import { startApp, type TestApp } from '../helpers/app';
import { addUser, entryInput, figureDoc, journalClient, paragraphDoc, type TestUser } from '../helpers/journal';
import { createTestDb, type TestDb } from '../helpers/test-db';
import { KITCHEN_SINK } from '../journal/fixtures';

const T0 = new Date('2026-10-13T08:00:00Z');
const DAY = 24 * 3600 * 1000;
const png = async () =>
  (await import('sharp'))
    .default({ create: { width: 40, height: 30, channels: 3, background: '#2a7' } })
    .png()
    .toBuffer();

/** What the model sees after the "--- ENTRY ---" line. */
const entryOf = (prompt: string): string => prompt.split('--- ENTRY ---\n')[1] ?? '';

/** An executor that answers from a function, can wait for a cancel, and remembers what it was asked. */
class Scripted implements SkillExecutor {
  readonly kind = 'fake' as const;
  readonly inputs: ExecInput[] = [];
  reply: (prompt: string) => string = (p) => entryOf(p);
  mode: 'answer' | 'hang' | 'throw' = 'answer';
  sawAbort = 0;
  running = 0;

  run(i: ExecInput): Promise<ExecResult> {
    this.inputs.push(i);
    this.running++;
    if (this.mode === 'throw') {
      this.running--;
      return Promise.reject(new Error('claude exited with code 1: simulated failure'));
    }
    if (this.mode === 'hang')
      return new Promise((_resolve, reject) => {
        i.onProgress('thinking');
        i.signal.addEventListener(
          'abort',
          () => {
            this.sawAbort++;
            this.running--;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      });
    this.running--;
    return Promise.resolve({ markdown: this.reply(i.prompt), costUsd: 0.0312, model: i.model });
  }
}

const SAMPLE = [
  'HK open weak, HSI -1.2% at open then recover by close. $0700.HK holding 600, the 560 put nov is ok but IV lower than last week. didnt sell.',
  'US: $NKE results after close, I have the 65 put exp 17 Oct, 4 days left, delta 0.18. If it drops below 68 I roll to Nov 62.5.',
];
const sampleDoc = (extra: unknown[] = []): JournalDocJson => ({
  type: 'doc',
  content: [
    ...SAMPLE.map((line) => {
      const parts = line.split(/(\$[A-Z0-9.]+)/);
      return {
        type: 'paragraph',
        content: parts
          .filter((p) => p !== '')
          .map((p) =>
            p.startsWith('$')
              ? {
                  type: 'text',
                  text: p.slice(1).replace('.HK', '') + (p.endsWith('.HK') ? '.HK' : ''),
                  marks: [
                    {
                      type: 'stockMention',
                      attrs: p.includes('.HK')
                        ? { market: 'HK', symbol: p.slice(1).replace('.HK', '') }
                        : { market: 'US', symbol: p.slice(1) },
                    },
                  ],
                }
              : { type: 'text', text: p },
          ),
      };
    }),
    ...extra,
  ] as JournalDocJson['content'],
});

describe('journal AI rewrite', () => {
  let db: TestDb;
  let tmp: string;
  let data: string;
  let t: TestApp;
  let ex: Scripted;
  let opts: { tmp: string; auth: object; now: Date; dataDir: string; executor: SkillExecutor; journal?: object };
  let alice: TestUser;
  let bob: TestUser;
  let a: ReturnType<typeof journalClient>;
  let b: ReturnType<typeof journalClient>;
  let anon: ReturnType<typeof journalClient>;
  let nth = 0;

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-ai-'));
    data = join(tmp, 'data');
    mkdirSync(data);
    ex = new Scripted();
    ex.reply = polished;
    opts = { tmp, auth: {}, now: T0, dataDir: data, executor: ex, journal: { timeoutMs: 1500 } };
    t = await startApp(db, opts);
    alice = await addUser(db, 'alice', T0);
    bob = await addUser(db, 'bob', T0);
    a = journalClient(t, alice.cookie);
    b = journalClient(t, bob.cookie);
    anon = journalClient(t);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh entry on its own day, saved with the given document. */
  const entry = async (doc: JournalDocJson = sampleDoc(), c = a) => {
    const date = `2027-01-${String(++nth).padStart(2, '0')}`;
    const r = await c.put(`/api/journal/entries/${date}`, entryInput(doc));
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    return { date, view: r.json };
  };
  const start = (date: string, body: object = { mode: 'polish' }, c = a) =>
    c.post(`/api/journal/entries/${date}/ai`, body);
  const settle = async (id: string, c = a) => {
    for (let n = 0; n < 200; n++) {
      const r = await c.get(`/api/journal/ai/${id}`);
      if (!['queued', 'running'].includes(r.json.status)) return r.json;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('the run did not finish');
  };
  const polished = (p: string): string =>
    entryOf(p).replace('didnt sell', 'I did not sell').replace('then recover by', 'then recovered by');

  describe('the login gate', () => {
    const id = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';
    it.each([
      ['POST', '/api/journal/entries/2027-01-01/ai', { mode: 'polish' }],
      ['GET', '/api/journal/entries/2027-01-01/ai', undefined],
      ['GET', `/api/journal/ai/${id}`, undefined],
      ['POST', `/api/journal/ai/${id}/cancel`, undefined],
      ['POST', `/api/journal/ai/${id}/accept`, undefined],
      ['POST', `/api/journal/ai/${id}/reject`, undefined],
      ['GET', '/api/journal/snapshot?kind=positions', undefined],
    ])('%s %s answers 401 without a session', async (method, url, body) => {
      expect((await anon.call(method as 'GET', url, body)).status).toBe(401);
    });

    it('does not let an encoded path skip the gate', async () => {
      expect((await anon.post(`/%61pi/journal/ai/${id}/accept`)).status).toBe(401);
      expect((await anon.post('/%61pi/journal/entries/2027-01-01/ai', { mode: 'polish' })).status).toBe(401);
      expect((await anon.get(`/api/journal/ai/%2e%2e/${id}`)).status).not.toBe(200);
    });
  });

  describe('a rewrite end to end (FakeExecutor, no real model)', () => {
    it('runs queued -> running -> done, shows a suggestion with the locked blocks restored, and changes nothing until accepted', async () => {
      const figure = await a.upload(await png(), 'chart.png');
      const doc = sampleDoc([
        { type: 'figure', attrs: { assetId: figure.json.id, caption: 'Tencent 1D' } },
        ...(KITCHEN_SINK.content ?? []).filter((n) => ['table', 'snapshot', 'taskList'].includes(n.type)),
      ]);
      const { date, view } = await entry(doc);

      const s = await start(date);
      expect(s.status).toBe(202);
      const runId = s.json.runId as string;
      const first = await a.get(`/api/journal/ai/${runId}`);
      expect(['queued', 'running', 'done']).toContain(first.json.status);
      expect(first.json.accepted).toBeNull();

      const done = await settle(runId);
      expect(done.status).toBe('done');
      expect(done.mode).toBe('polish');
      expect(done.date).toBe(date);
      expect(done.model).toBe('claude-haiku-5-5');
      expect(done.costUsd).toBeCloseTo(0.0312, 4);
      expect(done.error).toBeNull();
      expect(done.progress[0]).toMatch(/^prose: \d+ words, 4 locked blocks \(image, checklist, table, snapshot\)$/);
      expect(done.progress).toContain('mode: Polish');
      expect(done.progress).toContain('context: none');
      expect(done.progress).toContain('claude -p · no tools · cap $0.10 · model claude-haiku-5-5');
      expect(done.result.lockedKept).toBe(4);
      expect(done.result.lockedTotal).toBe(4);
      expect(done.result.inputMarkdown).toContain('[[FIG:1]]');
      expect(done.result.outputMarkdown).toContain('I did not sell');
      const types = (done.result.doc.content as { type: string }[]).map((n) => n.type);
      expect(types).toEqual(['paragraph', 'paragraph', 'figure', 'taskList', 'table', 'snapshot']);

      // What the model was asked: no tools, a small cap, the configured model, and none of the locked content.
      const asked = ex.inputs.at(-1) as ExecInput;
      expect(asked.tools).toEqual([]);
      expect(asked.allowedTools).toEqual([]);
      expect(asked.maxBudgetUsd).toBe(0.1);
      expect(asked.model).toBe('claude-haiku-5-5');
      expect(asked.prompt).toContain('Mode: Polish.');
      for (const secret of ['Tencent 1D', figure.json.id, '+$210', 'Strike', 'roll NKE', 'update note'])
        expect(asked.prompt, secret).not.toContain(secret);

      // Nothing touched the entry.
      const after = (await a.get(`/api/journal/entries/${date}`)).json;
      expect(after.doc).toEqual(view.doc);
      expect(after.revisionNo).toBe(view.revisionNo);
      expect(after.updatedAt).toBe(view.updatedAt);
      expect(after.revisionCount).toBe(1);
      expect(after.lastAi).toBeNull();
    });

    it('accepting writes a revision, keeps the locked blocks byte for byte, and Undo brings the old text back', async () => {
      const { date, view } = await entry(sampleDoc([KITCHEN_SINK.content?.find((n) => n.type === 'taskList')]));
      const runId = (await start(date)).json.runId as string;
      const done = await settle(runId);
      expect(done.status).toBe('done');

      const accepted = await a.post(`/api/journal/ai/${runId}/accept`);
      expect(accepted.status).toBe(200);
      const { entry: after, undoRevisionNo } = accepted.json;
      expect(after.markdown).toContain('I did not sell');
      expect(after.revisionNo).toBe(view.revisionNo + 1);
      expect(after.revisionCount).toBe(2);
      expect(after.aiPolished).toBe(true);
      expect(after.lastAi.mode).toBe('polish');
      expect(stableJson(after.doc.content.at(-1))).toBe(stableJson(view.doc.content.at(-1)));
      expect(undoRevisionNo).toBe(1);

      const revs = (await a.get(`/api/journal/entries/${date}/revisions`)).json;
      expect(revs.map((r: { source: string }) => r.source)).toEqual(['ai_accepted', 'user']);
      expect(revs[0].current).toBe(true);
      const run = (await a.get(`/api/journal/ai/${runId}`)).json;
      expect(run.accepted).toBe(true);
      const row = (await db.db.select().from(journalAiRuns).where(eq(journalAiRuns.id, runId)))[0];
      expect(row?.accepted).toBe(true);

      // Undo restores the revision below it: the author's own text, exactly.
      const undone = await a.post(`/api/journal/entries/${date}/revisions/${undoRevisionNo}/restore`);
      expect(stableJson(undone.json.doc)).toBe(stableJson(view.doc));

      // A suggestion can be used once.
      const again = await a.post(`/api/journal/ai/${runId}/accept`);
      expect(again.status).toBe(409);
      expect(again.json.error.code).toBe('already_decided');
    });

    it('keeps mine: rejecting changes nothing and the suggestion cannot be accepted afterwards', async () => {
      const { date, view } = await entry();
      const runId = (await start(date)).json.runId as string;
      await settle(runId);
      const r = await a.post(`/api/journal/ai/${runId}/reject`);
      expect(r.json.accepted).toBe(false);
      const after = (await a.get(`/api/journal/entries/${date}`)).json;
      expect(after.doc).toEqual(view.doc);
      expect(after.revisionNo).toBe(view.revisionNo);
      expect((await a.post(`/api/journal/ai/${runId}/accept`)).json.error.code).toBe('already_decided');
    });

    it('lets the author find a suggestion that waited (newest run of the entry)', async () => {
      const { date } = await entry();
      expect((await a.get(`/api/journal/entries/${date}/ai`)).json).toBeNull();
      const runId = (await start(date)).json.runId as string;
      await settle(runId);
      const latest = (await a.get(`/api/journal/entries/${date}/ai`)).json;
      expect(latest.id).toBe(runId);
      expect(latest.status).toBe('done');
      expect(latest.result.doc.type).toBe('doc');
    });

    it('refuses to accept onto an entry that was edited after the run started', async () => {
      const { date, view } = await entry();
      const runId = (await start(date)).json.runId as string;
      await settle(runId);
      const edited = await a.put(
        `/api/journal/entries/${date}`,
        entryInput(paragraphDoc('I kept writing meanwhile'), { revisionNo: view.revisionNo }),
      );
      expect(edited.status).toBe(200);
      const r = await a.post(`/api/journal/ai/${runId}/accept`);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('entry_changed');
      expect((await a.get(`/api/journal/entries/${date}`)).json.markdown).toBe('I kept writing meanwhile');
      // The run is still undecided: the author can ask again or keep mine.
      expect((await a.get(`/api/journal/ai/${runId}`)).json.accepted).toBeNull();
    });
  });

  describe('a run that must not touch the entry', () => {
    const bytesOf = async (date: string) => {
      const r = (await a.get(`/api/journal/entries/${date}`)).json;
      const row = (await db.db.select().from(journalEntries).where(eq(journalEntries.entryDate, date)))[0];
      return JSON.stringify({
        doc: r.doc,
        md: r.markdown,
        rev: r.revisionNo,
        upd: r.updatedAt,
        db: row?.updatedAt,
        n: r.revisionCount,
      });
    };

    it('fails with the reason when the rewrite changes a number, and the entry is byte-identical', async () => {
      const { date } = await entry();
      const before = await bytesOf(date);
      ex.reply = (p) => entryOf(p).replace('62.5', '62.6');
      const runId = (await start(date)).json.runId as string;
      const run = await settle(runId);
      ex.reply = polished;
      expect(run.status).toBe('failed');
      expect(run.result).toBeNull();
      expect(run.error).toContain('nothing was changed');
      expect(run.error).toContain('62.5');
      expect(await bytesOf(date)).toBe(before);
      // A failed run cannot be accepted.
      expect((await a.post(`/api/journal/ai/${runId}/accept`)).json.error.code).toBe('run_not_ready');
    });

    it('fails when the model loses a placeholder, even if the rest is perfect', async () => {
      const figure = await a.upload(await png(), 'c2.png');
      const { date } = await entry(
        figureDoc(figure.json.id, 'cap', 'Held 600 on $NKE today and sold nothing at all, as planned'),
      );
      const before = await bytesOf(date);
      ex.reply = (p) => entryOf(p).replace('[[FIG:1]]', '');
      const run = await settle((await start(date)).json.runId);
      ex.reply = polished;
      expect(run.status).toBe('failed');
      expect(run.error).toContain('[[FIG:1]]');
      expect(await bytesOf(date)).toBe(before);
    });

    it('fails when the model throws, and says so in words', async () => {
      const { date } = await entry();
      const before = await bytesOf(date);
      ex.mode = 'throw';
      const run = await settle((await start(date)).json.runId);
      ex.mode = 'answer';
      expect(run.status).toBe('failed');
      expect(run.error).toContain('The model run failed');
      expect(run.error).toContain('Nothing was changed');
      expect(await bytesOf(date)).toBe(before);
    });

    it('takes a code fence off an answer that was wrapped in one', async () => {
      const { date } = await entry();
      ex.reply = (p) => `\`\`\`markdown\n${polished(p)}\n\`\`\``;
      const run = await settle((await start(date)).json.runId);
      ex.reply = polished;
      expect(run.status).toBe('done');
      expect(run.result.outputMarkdown.startsWith('```')).toBe(false);
    });

    it('cancels a running rewrite: the model process is told to stop and the entry is untouched', async () => {
      const { date } = await entry();
      const before = await bytesOf(date);
      ex.mode = 'hang';
      const abortsBefore = ex.sawAbort;
      const runId = (await start(date)).json.runId as string;
      for (let n = 0; n < 100 && (await a.get(`/api/journal/ai/${runId}`)).json.status !== 'running'; n++)
        await new Promise((r) => setTimeout(r, 20));
      expect((await a.get(`/api/journal/ai/${runId}`)).json.status).toBe('running');
      const cancelled = await a.post(`/api/journal/ai/${runId}/cancel`);
      ex.mode = 'answer';
      expect(cancelled.json.status).toBe('cancelled');
      expect(ex.sawAbort).toBe(abortsBefore + 1);
      expect(await bytesOf(date)).toBe(before);
      expect((await a.post(`/api/journal/ai/${runId}/accept`)).json.error.code).toBe('run_not_ready');
    });

    it('gives up after the timeout and says so', async () => {
      const { date } = await entry();
      ex.mode = 'hang';
      const run = await settle((await start(date)).json.runId);
      ex.mode = 'answer';
      expect(run.status).toBe('failed');
      expect(run.error).toContain('did not answer within 2 seconds');
      expect(ex.running).toBe(0);
    });
  });

  describe('one at a time, and a daily cap', () => {
    it('lets only one rewrite run per entry', async () => {
      const { date } = await entry();
      ex.mode = 'hang';
      const first = await start(date);
      expect(first.status).toBe(202);
      const second = await start(date);
      expect(second.status).toBe(409);
      expect(second.json.error.code).toBe('run_in_progress');
      expect(second.json.error.details).toEqual({ runId: first.json.runId });
      await a.post(`/api/journal/ai/${first.json.runId}/cancel`);
      ex.mode = 'answer';
      expect((await start(date)).status).toBe(202);
      await t.app.services.journalAi.idle();
    });

    it('cancels a rewrite that is still waiting in the queue, and it never runs', async () => {
      ex.mode = 'hang';
      const days = [await entry(), await entry(), await entry()];
      const runs = [];
      for (const d of days) runs.push((await start(d.date)).json.runId as string);
      // Two run at once; the third waits.
      let status: string[] = [];
      for (let n = 0; n < 200; n++) {
        status = await Promise.all(runs.map(async (id) => (await a.get(`/api/journal/ai/${id}`)).json.status));
        if (status.filter((s) => s === 'running').length === 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(status.filter((s) => s === 'running')).toHaveLength(2);
      expect(status.filter((s) => s === 'queued')).toHaveLength(1);
      const queued = runs[status.indexOf('queued')] as string;
      const calls = ex.inputs.length;
      const cancelled = await a.post(`/api/journal/ai/${queued}/cancel`);
      expect(cancelled.json.status).toBe('cancelled');
      for (const id of runs) if (id !== queued) await a.post(`/api/journal/ai/${id}/cancel`);
      ex.mode = 'answer';
      await t.app.services.journalAi.idle();
      expect(ex.inputs.length).toBe(calls);
    });

    it('answers 429 once the day is used up, counting every run whatever became of it, and starts again tomorrow', async () => {
      opts.journal = { timeoutMs: 1500, dailyRuns: 1 };
      const capped = await startApp(db, { ...opts, journal: { timeoutMs: 1500, dailyRuns: 2 } });
      // A user who has not used any rewrites today (Alice has, in the tests above).
      const carol = await addUser(db, 'carol', T0);
      const c = journalClient(capped, carol.cookie);
      const { date } = await (async () => {
        const d = `2028-02-${String(++nth).padStart(2, '0')}`;
        await c.put(`/api/journal/entries/${d}`, entryInput(sampleDoc()));
        return { date: d };
      })();
      const run = async (body: object = { mode: 'polish' }) => c.post(`/api/journal/entries/${date}/ai`, body);
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await run();
        expect(r.status).toBe(202);
        ids.push(r.json.runId);
        // reject so the next one is free to start
        for (let n = 0; n < 200 && (await c.get(`/api/journal/ai/${r.json.runId}`)).json.status !== 'done'; n++)
          await new Promise((res) => setTimeout(res, 25));
      }
      const third = await run();
      expect(third.status).toBe(429);
      expect(third.json.error.code).toBe('daily_limit');
      expect(third.json.error.message).toContain("today's 2 rewrites");
      // Another user has their own count.
      const bobsClient = journalClient(capped, bob.cookie);
      await bobsClient.put('/api/journal/entries/2028-02-01', entryInput(sampleDoc()));
      expect((await bobsClient.post('/api/journal/entries/2028-02-01/ai', { mode: 'polish' })).status).toBe(202);
      // The next UTC day starts a new count.
      (capped.deps as { now: () => Date }).now = () => new Date(T0.getTime() + DAY);
      expect((await run()).status).toBe(202);
      await capped.close();
    });
  });

  describe('input rules', () => {
    it('needs an entry with text, a valid mode, and an instruction for custom', async () => {
      expect((await start('2030-05-05')).status).toBe(404);
      const { date } = await entry();
      expect((await start(date, { mode: 'rewrite-everything' })).status).toBe(400);
      expect((await start(date, { mode: 'custom' })).json.error.code).toBe('instruction_required');
      expect((await start(date, { mode: 'custom', instruction: '   ' })).json.error.code).toBe('instruction_required');
      expect((await start(date, { mode: 'polish', instruction: 'x'.repeat(501) })).json.error.code).toBe(
        'invalid_instruction',
      );
      expect((await start(date, { mode: 'polish', extra: true })).status).toBe(400);
      const figure = await a.upload(await png(), 'only.png');
      const onlyPicture = await entry({
        type: 'doc',
        content: [{ type: 'figure', attrs: { assetId: figure.json.id, caption: null } }],
      });
      expect((await start(onlyPicture.date)).json.error.code).toBe('nothing_to_rewrite');
    });

    it("passes the author's instruction in their words, and context only when switched on", async () => {
      const { date } = await entry();
      const plain = await settle((await start(date)).json.runId);
      expect(ex.inputs.at(-1)?.prompt).not.toContain('For reference only');
      expect(plain.progress).toContain('context: none');
      const run = await settle(
        (await start(date, { mode: 'custom', instruction: 'write it as a letter to my future self' })).json.runId,
      );
      expect(ex.inputs.at(-1)?.prompt).toContain('"write it as a letter to my future self"');
      expect(run.progress).toContain('mode: Custom · "write it as a letter to my future self"');
      expect(run.instruction).toBe('write it as a letter to my future self');
    });

    it('says so when there is no AI executor', async () => {
      const bare = await startApp(db, { ...opts, executor: new FakeExecutor() });
      (bare.deps.research as { executorKind: string }).executorKind = 'none';
      const c = journalClient(bare, alice.cookie);
      const { date } = await entry();
      const r = await c.post(`/api/journal/entries/${date}/ai`, { mode: 'polish' });
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('ai_unavailable');
      expect(r.json.error.message).toContain('OT_CLAUDE_CLI');
      await bare.close();
    });
  });

  describe('context and snapshots', () => {
    it("gives the model today's positions only when asked, as reference, and shows it in the progress lines", async () => {
      const added = await a.post('/api/positions', {
        symbol: 'NKE',
        market: 'US',
        strike: 65,
        expiry: '2026-10-30',
        contracts: 1,
        price: 1.48,
        date: '2026-10-09',
      });
      if (added.status !== 201) {
        // The instrument has to exist first.
        await db.db.execute(
          (await import('drizzle-orm'))
            .sql`insert into instruments (market, symbol, currency) values ('US', 'NKE', 'USD') on conflict do nothing`,
        );
        expect(
          (
            await a.post('/api/positions', {
              symbol: 'NKE',
              market: 'US',
              strike: 65,
              expiry: '2026-10-30',
              contracts: 1,
              price: 1.48,
              date: '2026-10-09',
            })
          ).status,
        ).toBe(201);
      }
      const { date } = await entry();
      const run = await settle((await start(date, { mode: 'polish', withContext: true })).json.runId);
      const prompt = ex.inputs.at(-1)?.prompt ?? '';
      expect(run.withContext).toBe(true);
      expect(prompt).toContain('For reference only, do not copy into the entry:');
      expect(prompt).toContain('Open positions (from the app,');
      expect(prompt).toContain('- NKE put 65 exp 2026-10-30 x1');
      expect(run.progress.find((l: string) => l.startsWith('context: '))).toMatch(/^context: today's 1 position/);
      // The reference block sits before the entry and is not part of what is rewritten.
      expect(prompt.indexOf('For reference only')).toBeLessThan(prompt.indexOf('--- ENTRY ---'));
      expect(entryOf(prompt)).not.toContain('Open positions');
    });

    it('serves a frozen positions table that matches the Positions page, and refuses another kind', async () => {
      const snap = await a.get('/api/journal/snapshot?kind=positions');
      expect(snap.status).toBe(200);
      expect(snap.json).toMatchObject({ kind: 'positions', title: 'Open positions' });
      expect(snap.json.columns).toEqual(['Name', 'Put', 'Exp', 'DTE', 'Qty', 'Credit', 'P&L']);
      const positions = (await a.get('/api/positions')).json.open as {
        symbol: string;
        strike: number;
        expiry: string;
        dte: number;
        quantity: number;
      }[];
      expect(snap.json.rows).toHaveLength(positions.length);
      expect(positions.length).toBeGreaterThan(0);
      const nke = snap.json.rows.find((r: string[]) => r[0] === 'NKE');
      expect(nke.slice(0, 5)).toEqual(['NKE', '65', '30 Oct', String(positions[0]?.dte), '1']);
      expect(nke[5]).toBe('$148');
      expect((await a.get('/api/journal/snapshot?kind=weather')).status).toBe(400);
      expect((await a.get('/api/journal/snapshot')).status).toBe(400);
    });
  });

  describe("one user never sees another's rewrite", () => {
    it('answers 404 to every route for a run that is not theirs', async () => {
      const { date } = await entry();
      const runId = (await start(date)).json.runId as string;
      await settle(runId);
      expect((await b.get(`/api/journal/ai/${runId}`)).status).toBe(404);
      expect((await b.post(`/api/journal/ai/${runId}/cancel`)).status).toBe(404);
      expect((await b.post(`/api/journal/ai/${runId}/accept`)).status).toBe(404);
      expect((await b.post(`/api/journal/ai/${runId}/reject`)).status).toBe(404);
      expect((await b.get(`/api/journal/entries/${date}/ai`)).status).toBe(404);
      expect((await b.post(`/api/journal/entries/${date}/ai`, { mode: 'polish' })).status).toBe(404);
      expect((await a.get(`/api/journal/ai/${runId}`)).json.accepted).toBeNull();
      expect((await a.get('/api/journal/ai/not-an-id')).status).toBe(404);
    });
  });
});
