/** Regression tests for the defects an independent review of the journal server found. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalAssets } from '../../src/db/schema';
import { cleanJournal } from '../../src/jobs/journal-cleanup';
import type { JournalDocJson } from '../../src/journal';
import { FakeExecutor } from '../../src/server/research/executor';
import { startApp, type TestApp } from '../helpers/app';
import { addUser, entryInput, figureDoc, journalClient, paragraphDoc, type TestUser } from '../helpers/journal';
import { createTestDb, type TestDb } from '../helpers/test-db';

const T0 = new Date('2026-10-13T08:00:00Z');
const png = (background = '#2a7') =>
  sharp({ create: { width: 30, height: 20, channels: 3, background } })
    .png()
    .toBuffer();

describe('journal review fixes', () => {
  let db: TestDb;
  let tmp: string;
  let data: string;
  let t: TestApp;
  let alice: TestUser;
  let a: ReturnType<typeof journalClient>;
  const opts = {
    tmp: '',
    auth: {},
    now: T0,
    dataDir: '',
    journal: { timeoutMs: 2000, dailyRuns: 3 },
    executor: undefined as unknown,
  };

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-fix-'));
    data = join(tmp, 'data');
    mkdirSync(data);
    const executor = new FakeExecutor({ reply: (p) => p.split('--- ENTRY ---\n')[1] ?? '' });
    t = await startApp(db, {
      tmp,
      auth: {},
      now: T0,
      dataDir: data,
      journal: { timeoutMs: 2000, dailyRuns: 3 },
      executor,
    });
    alice = await addUser(db, 'alice', T0);
    a = journalClient(t, alice.cookie);
    void opts;
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const put = (date: string, doc: JournalDocJson | unknown, over = {}) =>
    a.put(`/api/journal/entries/${date}`, { ...entryInput(paragraphDoc('x')), doc, ...over });

  it('stores an image id in lower case even when the client sends it in upper case, so the image counts as in use', async () => {
    const up = await a.upload(await png('#111'), 'a.png');
    const id = up.json.id as string;
    const saved = await put('2027-03-01', figureDoc(id.toUpperCase()));
    expect(saved.status, saved.text.slice(0, 200)).toBe(200);
    expect(saved.json.markdown).toContain(`asset:${id}`);
    expect(JSON.stringify(saved.json.doc)).not.toContain(id.toUpperCase());
    const del = await a.del(`/api/journal/assets/${id}`);
    expect(del.status).toBe(409);
    expect(del.json.error.code).toBe('asset_in_use');
  });

  it('answers 400, not 500, for text the database cannot store', async () => {
    const nul = await put('2027-03-02', paragraphDoc('a\u0000b'));
    expect(nul.status).toBe(400);
    expect(nul.json.error.code).toBe('invalid_document');
    expect((await put('2027-03-02', paragraphDoc('a\ud800b'))).status).toBe(400);
    expect((await put('2027-03-02', paragraphDoc('fine'), { title: 'bad\u0000title' })).json.error.code).toBe(
      'invalid_title',
    );
    const weird = await put('2027-03-02', {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: JSON.parse('{"__proto__":1}') }],
    });
    expect(weird.status).toBe(400);
  });

  it('stores a heading sent without a level as level 2, and lets the editor save it again', async () => {
    const first = await put('2027-03-03', {
      type: 'doc',
      content: [{ type: 'heading', content: [{ type: 'text', text: 'Plan' }] }],
    });
    expect(first.status).toBe(200);
    expect(first.json.doc.content[0].attrs).toEqual({ level: 2 });
    const again = await put('2027-03-03', first.json.doc, {
      revisionNo: first.json.revisionNo,
      title: 'now with a title',
    });
    expect(again.status).toBe(200);
  });

  it('counts an indented "Lesson:" line in the summary and in the Lessons list alike', async () => {
    const doc: JournalDocJson = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Rolled early' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Lesson: indented lessons count' }] },
              ],
            },
          ],
        },
      ],
    };
    expect((await put('2027-04-05', doc)).status).toBe(200);
    const lessons = (await a.get('/api/journal/lessons')).json.lessons as { date: string; text: string }[];
    expect(lessons.filter((l) => l.date === '2027-04-05').map((l) => l.text)).toEqual(['indented lessons count']);
    expect((await a.get('/api/journal/entries?today=2027-04-05')).json.summary.lessons).toBe(1);
  });

  it('starts a deleted day afresh: the old text does not live on in History, and Undo still brings the whole thing back', async () => {
    const first = await put('2027-05-01', paragraphDoc('secret plan'));
    expect(first.status).toBe(200);
    await a.del('/api/journal/entries/2027-05-01');
    // Undo keeps the history (it is the same entry coming back).
    const undone = await a.post('/api/journal/entries/2027-05-01/undelete');
    expect(undone.json.revisionCount).toBe(1);
    await a.del('/api/journal/entries/2027-05-01');
    // Writing the day again is a new entry.
    const fresh = await put('2027-05-01', paragraphDoc('something else entirely'));
    expect(fresh.status).toBe(200);
    expect(fresh.json.revisionCount).toBe(1);
    const revs = (await a.get('/api/journal/entries/2027-05-01/revisions')).json;
    expect(revs).toHaveLength(1);
    expect(JSON.stringify(revs)).not.toContain('secret');
  });

  it('answers 409 to the second of two devices saving a new day at the same moment, not a 500', async () => {
    const [x, y] = await Promise.all([
      put('2027-06-01', paragraphDoc('phone')),
      put('2027-06-01', paragraphDoc('laptop')),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.json.error.code).toBe('revision_conflict');
    expect(loser.json.error.details.currentRevisionNo).toBe(1);
  });

  it('answers 400 or 200 for absurd paging and revision numbers, never 500', async () => {
    expect((await a.get('/api/journal/entries?page=1e300')).status).toBe(200);
    expect((await a.get('/api/journal/entries?page=-5&pageSize=1e9')).status).toBe(200);
    await put('2027-06-02', paragraphDoc('x'));
    expect((await a.post('/api/journal/entries/2027-06-02/revisions/99999999999/restore')).status).toBe(400);
    expect((await a.post('/api/journal/entries/2027-06-02/revisions/1999999999/restore')).status).toBe(404);
  });

  it('keeps an image that was uploaded again after it became an orphan, and removes one nothing wants', async () => {
    const day = 24 * 3600 * 1000;
    const bytes = await png('#222');
    const first = (await a.upload(bytes, 'first.png')).json.id as string;
    await db.db
      .update(journalAssets)
      .set({ createdAt: new Date(T0.getTime() - 3 * day) })
      .where(eq(journalAssets.id, first));
    const again = (await a.upload(bytes, 'again.png')).json.id as string;
    expect(again).toBe(first);
    const lonely = (await a.upload(await png('#333'), 'lonely.png')).json.id as string;
    await db.db
      .update(journalAssets)
      .set({ createdAt: new Date(T0.getTime() - 3 * day) })
      .where(eq(journalAssets.id, lonely));
    const result = await cleanJournal(db.db, data, T0);
    expect(result.deletedAssets).toBeGreaterThanOrEqual(1);
    const left = new Set((await db.db.select({ id: journalAssets.id }).from(journalAssets)).map((r) => r.id));
    expect(left.has(first)).toBe(true);
    expect(left.has(lonely)).toBe(false);
    expect(existsSync(join(data, 'journal', alice.id, '2026'))).toBe(true);
  });

  it('lets one of two simultaneous accepts through and tells the other the suggestion was already used', async () => {
    const date = '2027-07-01';
    await put(date, paragraphDoc('Held 600 on $NKE today and did not sell anything at all, as planned.'));
    const run = (await a.post(`/api/journal/entries/${date}/ai`, { mode: 'polish' })).json.runId as string;
    for (let n = 0; n < 200 && (await a.get(`/api/journal/ai/${run}`)).json.status !== 'done'; n++)
      await new Promise((r) => setTimeout(r, 25));
    expect((await a.get(`/api/journal/ai/${run}`)).json.status).toBe('done');
    const [x, y] = await Promise.all([
      a.post(`/api/journal/ai/${run}/accept`),
      a.post(`/api/journal/ai/${run}/accept`),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((x.status === 409 ? x : y).json.error.code).toBe('already_decided');
  });

  it('holds the daily cap under parallel starts: exactly the allowed number get through', async () => {
    const dates = ['2027-08-01', '2027-08-02', '2027-08-03', '2027-08-04', '2027-08-05', '2027-08-06'];
    for (const d of dates)
      await put(d, paragraphDoc('Held 600 on $NKE today and did not sell anything at all, as planned.'));
    const results = await Promise.all(dates.map((d) => a.post(`/api/journal/entries/${d}/ai`, { mode: 'polish' })));
    const ok = results.filter((r) => r.status === 202).length;
    const capped = results.filter((r) => r.status === 429).length;
    // Alice already used one run in the accept test above; the cap is 3 a day.
    expect(ok + capped).toBe(dates.length);
    expect(ok).toBe(2);
    await t.app.services.journalAi.idle();
  });
});
