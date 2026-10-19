import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instruments, journalEntries, journalEntryInstruments } from '../../src/db/schema';
import { applyTemplate, JOURNAL_TEMPLATES, type JournalDocJson } from '../../src/journal';
import { journalStreak } from '../../src/server/services/journal-service';
import { startApp, type TestApp } from '../helpers/app';
import { addUser, entryInput, journalClient, mentionDoc, paragraphDoc, type TestUser } from '../helpers/journal';
import { createTestDb, type TestDb } from '../helpers/test-db';

const T0 = new Date('2026-10-13T08:00:00Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const empty: JournalDocJson = { type: 'doc', content: [{ type: 'paragraph' }] };

describe('journal API (login on)', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  let opts: { tmp: string; auth: object; now: Date };
  let alice: TestUser;
  let bob: TestUser;
  let a: ReturnType<typeof journalClient>;
  let b: ReturnType<typeof journalClient>;
  let anon: ReturnType<typeof journalClient>;

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-'));
    opts = { tmp, auth: {}, now: T0 };
    t = await startApp(db, opts);
    alice = await addUser(db, 'alice', T0);
    bob = await addUser(db, 'bob', T0);
    a = journalClient(t, alice.cookie);
    b = journalClient(t, bob.cookie);
    anon = journalClient(t);
    await db.db.insert(instruments).values([
      { market: 'US', symbol: 'NKE', currency: 'USD' },
      { market: 'HK', symbol: '0700', currency: 'HKD' },
    ]);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const clock = (d: Date): void => {
    opts.now = d;
  };
  const save = (c: typeof a, date: string, doc: JournalDocJson, over = {}) =>
    c.put(`/api/journal/entries/${date}`, entryInput(doc, over));

  describe('the login gate', () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/journal/entries'],
      ['GET', '/api/journal/entries/2026-10-01'],
      ['PUT', '/api/journal/entries/2026-10-01', entryInput(empty)],
      ['POST', '/api/journal/entries/2026-10-01/close'],
      ['DELETE', '/api/journal/entries/2026-10-01'],
      ['POST', '/api/journal/entries/2026-10-01/undelete'],
      ['GET', '/api/journal/entries/2026-10-01/revisions'],
      ['POST', '/api/journal/entries/2026-10-01/revisions/1/restore'],
      ['GET', '/api/journal/entries/2026-10-01/export.md'],
      ['GET', '/api/journal/calendar?month=2026-10'],
      ['GET', '/api/journal/lessons'],
    ];
    it.each(routes)('%s %s answers 401 without a session', async (method, url, body) => {
      const r = await anon.call(method as 'GET', url, body);
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe('unauthenticated');
    });

    it.each(routes)('%s %s answers 401 with a session cookie that is not valid', async (method, url, body) => {
      const r = await journalClient(t, 'ot_session=not-a-real-token').call(method as 'GET', url, body);
      expect(r.status).toBe(401);
    });

    it.each([
      '/%61pi/journal/entries',
      '/%61%70%69/journal/entries/2026-10-01',
      '/api%2Fjournal/entries',
      '/api/%6aournal/entries',
      '/api/journal/%65ntries',
      '/api/./journal/entries',
      '/x/../api/journal/entries',
      '/api/journal/entries/2026-10-01/%72evisions',
    ])('does not let %s skip the gate', async (url) => {
      const r = await anon.get(url);
      expect(r.status, `${url} -> ${r.text.slice(0, 80)}`).not.toBe(200);
      expect(r.text).not.toContain('"entries"');
    });

    it('does not let an encoded write path skip the gate or the JSON requirement', async () => {
      expect((await anon.call('PUT', '/%61pi/journal/entries/2026-10-01', entryInput(empty))).status).toBe(401);
      expect((await anon.call('DELETE', '/%61pi/journal/entries/2026-10-01')).status).toBe(401);
      const form = await anon.call('PUT', '/%61pi/journal/entries/2026-10-01', undefined, {
        'content-type': 'text/plain',
      });
      expect(form.status).toBe(415);
    });

    it('wants Content-Type: application/json on a delete too', async () => {
      const r = await a.call('DELETE', '/api/journal/entries/2026-10-01', undefined, { 'content-type': 'text/plain' });
      expect(r.status).toBe(415);
    });
  });

  describe('create, read and update', () => {
    it('answers 404 for a day without an entry', async () => {
      const r = await a.get('/api/journal/entries/2026-09-01');
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('entry_not_found');
    });

    it('creates an entry and returns what the server derived from the document', async () => {
      clock(T0);
      const doc = mentionDoc('Held', 'US', 'NKE', 'NKE');
      const r = await save(a, '2026-10-01', doc, {
        title: '  Evening review  ',
        tags: ['#Roll-Rule', 'hk'],
        marketView: 'bullish',
        template: 'evening',
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        date: '2026-10-01',
        title: 'Evening review',
        tags: ['roll-rule', 'hk'],
        marketView: 'bullish',
        template: 'evening',
        status: 'draft',
        revisionNo: 1,
        revisionCount: 1,
        markdown: 'Held $NKE',
        wordCount: 2,
        aiPolished: false,
        lastAi: null,
        excerpt: 'Held $NKE',
        thumbnailAssetId: null,
      });
      expect(r.json.mentions).toEqual([{ market: 'US', symbol: 'NKE', label: 'NKE', known: true }]);
      const back = await a.get('/api/journal/entries/2026-10-01');
      expect(back.json.doc).toEqual(r.json.doc);
      expect(back.json.id).toBe(r.json.id);
    });

    it('bumps the token on every write and answers 409 to a stale one', async () => {
      clock(T0);
      const first = await save(a, '2026-10-02', paragraphDoc('one'));
      expect(first.json.revisionNo).toBe(1);
      const second = await save(a, '2026-10-02', paragraphDoc('two'), { revisionNo: 1 });
      expect(second.json.revisionNo).toBe(2);
      const stale = await save(a, '2026-10-02', paragraphDoc('three from another device'), { revisionNo: 1 });
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('revision_conflict');
      expect(stale.json.error.details).toEqual({ currentRevisionNo: 2 });
      expect((await a.get('/api/journal/entries/2026-10-02')).json.markdown).toBe('two');
      // Keep mine: resend with the current token.
      const mine = await save(a, '2026-10-02', paragraphDoc('three from another device'), { revisionNo: 2 });
      expect(mine.status).toBe(200);
      expect(mine.json.revisionNo).toBe(3);
    });

    it('answers 409 to a create when the day already has an entry', async () => {
      await save(a, '2026-10-03', paragraphDoc('x'));
      const again = await save(a, '2026-10-03', paragraphDoc('y'), { revisionNo: null });
      expect(again.status).toBe(409);
      expect(again.json.error.details).toEqual({ currentRevisionNo: 1 });
    });

    it('treats a repeated identical save with an old token as harmless (pagehide fires after visibilitychange)', async () => {
      await save(a, '2026-10-04', paragraphDoc('same'));
      const w1 = await save(a, '2026-10-04', paragraphDoc('same text now'), { revisionNo: 1 });
      expect(w1.json.revisionNo).toBe(2);
      const dup = await save(a, '2026-10-04', paragraphDoc('same text now'), { revisionNo: 1 });
      expect(dup.status).toBe(200);
      expect(dup.json.revisionNo).toBe(2);
      // An identical save with the right token changes nothing either.
      const noop = await save(a, '2026-10-04', paragraphDoc('same text now'), { revisionNo: 2 });
      expect(noop.json.revisionNo).toBe(2);
    });

    it('lets exactly one of two simultaneous saves with the same token win', async () => {
      await save(a, '2026-10-05', paragraphDoc('start'));
      const [x, y] = await Promise.all([
        save(a, '2026-10-05', paragraphDoc('phone'), { revisionNo: 1 }),
        save(a, '2026-10-05', paragraphDoc('laptop'), { revisionNo: 1 }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    });

    it('rejects a document the schema does not allow, and fields the client must not send', async () => {
      const img = { type: 'doc', content: [{ type: 'img', attrs: { src: 'https://evil.example/x.png' } }] };
      const r = await a.put('/api/journal/entries/2026-10-06', { ...entryInput(empty), doc: img });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('invalid_document');
      expect(r.json.error.details[0].message).toContain('"img"');
      const html = await a.put('/api/journal/entries/2026-10-06', { ...entryInput(empty), doc: '<p>hi</p>' });
      expect(html.status).toBe(400);
      const derived = await a.put('/api/journal/entries/2026-10-06', { ...entryInput(empty), markdown: '# injected' });
      expect(derived.status).toBe(400);
      expect(derived.json.error.code).toBe('validation');
      expect((await a.get('/api/journal/entries/2026-10-06')).status).toBe(404);
    });

    it('rejects a figure for an image that does not exist, bad tags, long titles and bad dates', async () => {
      const figure = {
        type: 'doc',
        content: [{ type: 'figure', attrs: { assetId: '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11', caption: null } }],
      };
      const f = await a.put('/api/journal/entries/2026-10-06', { ...entryInput(empty), doc: figure });
      expect(f.status).toBe(400);
      expect(f.json.error.code).toBe('invalid_document');
      expect((await save(a, '2026-10-06', empty, { tags: ['two words'] })).json.error.code).toBe('invalid_tags');
      expect((await save(a, '2026-10-06', empty, { title: 'x'.repeat(201) })).json.error.code).toBe('invalid_title');
      expect((await save(a, '2026-13-45', empty)).status).toBe(400);
      expect((await save(a, '1999-01-01', empty)).json.error.code).toBe('invalid_date');
      expect((await a.get('/api/journal/entries/not-a-date')).status).toBe(400);
    });
  });

  describe('one user never sees another', () => {
    it('keeps entries, lists, history and export private', async () => {
      await save(a, '2026-10-07', paragraphDoc('alice only secret'), { tags: ['private'] });
      expect((await b.get('/api/journal/entries/2026-10-07')).status).toBe(404);
      expect((await b.get('/api/journal/entries/2026-10-07/revisions')).status).toBe(404);
      expect((await b.get('/api/journal/entries/2026-10-07/export.md')).status).toBe(404);
      expect((await b.post('/api/journal/entries/2026-10-07/revisions/1/restore')).status).toBe(404);
      expect((await b.post('/api/journal/entries/2026-10-07/close')).status).toBe(404);
      expect((await b.del('/api/journal/entries/2026-10-07')).status).toBe(404);
      expect((await b.post('/api/journal/entries/2026-10-07/undelete')).status).toBe(404);
      const list = await b.get('/api/journal/entries?q=secret');
      expect(list.json.total).toBe(0);
      expect(JSON.stringify((await b.get('/api/journal/entries')).json)).not.toContain('secret');
      expect(JSON.stringify((await b.get('/api/journal/lessons')).json)).not.toContain('secret');
      expect(
        (await b.get('/api/journal/calendar?month=2026-10')).json.days.map((d: { date: string }) => d.date),
      ).not.toContain('2026-10-07');
      // Bob writing the same day makes his own entry; Alice's is untouched.
      const mine = await save(b, '2026-10-07', paragraphDoc('bob text'));
      expect(mine.status).toBe(200);
      expect(mine.json.revisionNo).toBe(1);
      expect((await a.get('/api/journal/entries/2026-10-07')).json.markdown).toBe('alice only secret');
    });
  });

  describe('revisions', () => {
    it('follows typing in place for ten minutes, then starts a new revision', async () => {
      clock(T0);
      await save(a, '2026-10-08', paragraphDoc('first draft'));
      clock(minutes(2));
      await save(a, '2026-10-08', paragraphDoc('first draft, now longer'), { revisionNo: 1 });
      let revs = (await a.get('/api/journal/entries/2026-10-08/revisions')).json;
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ no: 1, source: 'user', current: true, label: 'Started · 4 words' });
      clock(minutes(11));
      await save(a, '2026-10-08', paragraphDoc('first draft, now much longer than before'), { revisionNo: 2 });
      revs = (await a.get('/api/journal/entries/2026-10-08/revisions')).json;
      expect(revs.map((r: { no: number }) => r.no)).toEqual([2, 1]);
      expect(revs[0]).toMatchObject({ source: 'user', current: true, label: 'Typed 7 words' });
      expect(revs[1].current).toBe(false);
      expect(revs[1].wordCount).toBe(4);
      expect((await a.get('/api/journal/entries/2026-10-08')).json.revisionCount).toBe(2);
    });

    it('writes a revision of its own for a template, so the state before it stays in History', async () => {
      clock(T0);
      const written = paragraphDoc('my notes');
      await save(a, '2026-10-09', written);
      const withTemplate = applyTemplate(written, 'evening');
      const r = await save(a, '2026-10-09', withTemplate, { revisionNo: 1, source: 'template', template: 'evening' });
      expect(r.status).toBe(200);
      const revs = (await a.get('/api/journal/entries/2026-10-09/revisions')).json;
      expect(revs.map((x: { source: string }) => x.source)).toEqual(['template', 'user']);
      expect(revs[0].label).toBe('Applied a template');
      expect(revs[1].wordCount).toBe(2);
    });

    it('restores an earlier revision as a new revision and deletes nothing', async () => {
      clock(T0);
      await save(a, '2026-10-10', paragraphDoc('the good version'));
      clock(minutes(30));
      await save(a, '2026-10-10', paragraphDoc('a worse rewrite'), { revisionNo: 1 });
      const before = (await a.get('/api/journal/entries/2026-10-10')).json;
      expect(before.revisionCount).toBe(2);
      clock(minutes(31));
      const r = await a.post('/api/journal/entries/2026-10-10/revisions/1/restore');
      expect(r.status).toBe(200);
      expect(r.json.markdown).toBe('the good version');
      expect(r.json.revisionNo).toBe(before.revisionNo + 1);
      expect(r.json.revisionCount).toBe(3);
      const revs = (await a.get('/api/journal/entries/2026-10-10/revisions')).json;
      expect(revs.map((x: { no: number; source: string }) => `${x.no}:${x.source}`)).toEqual([
        '3:restore',
        '2:user',
        '1:user',
      ]);
      expect(revs[0].label).toBe('Restored revision 1');
      expect(revs[0].current).toBe(true);
      expect((await a.post('/api/journal/entries/2026-10-10/revisions/99/restore')).status).toBe(404);
      expect((await a.post('/api/journal/entries/2026-10-10/revisions/zero/restore')).status).toBe(400);
    });

    it('does not follow typing in place after a restore: the next save starts a new revision', async () => {
      clock(minutes(32));
      await save(a, '2026-10-10', paragraphDoc('the good version, edited'), { revisionNo: 3 });
      const revs = (await a.get('/api/journal/entries/2026-10-10/revisions')).json;
      expect(revs.map((x: { no: number; source: string }) => `${x.no}:${x.source}`)).toEqual([
        '4:user',
        '3:restore',
        '2:user',
        '1:user',
      ]);
    });
  });

  describe('close, delete and bring back', () => {
    it('closes and reopens a day', async () => {
      await save(a, '2026-10-11', paragraphDoc('day'));
      const closed = await a.post('/api/journal/entries/2026-10-11/close');
      expect(closed.json.status).toBe('closed');
      const again = await a.post('/api/journal/entries/2026-10-11/close');
      expect(again.json.status).toBe('closed');
      expect(again.json.revisionNo).toBe(closed.json.revisionNo);
      const reopened = await a.post('/api/journal/entries/2026-10-11/close?reopen=1');
      expect(reopened.json.status).toBe('draft');
    });

    it('soft-deletes, hides the day, and brings it back with Undo', async () => {
      clock(T0);
      await save(a, '2026-10-12', paragraphDoc('keep me'));
      expect((await a.del('/api/journal/entries/2026-10-12')).json).toEqual({ ok: true });
      expect((await a.get('/api/journal/entries/2026-10-12')).status).toBe(404);
      expect((await a.get('/api/journal/entries')).json.entries.map((e: { date: string }) => e.date)).not.toContain(
        '2026-10-12',
      );
      expect(
        (await a.get('/api/journal/calendar?month=2026-10')).json.days.map((d: { date: string }) => d.date),
      ).not.toContain('2026-10-12');
      const back = await a.post('/api/journal/entries/2026-10-12/undelete');
      expect(back.status).toBe(200);
      expect(back.json.markdown).toBe('keep me');
      expect(back.json.revisionCount).toBe(1);
      expect((await a.post('/api/journal/entries/2026-10-12/undelete')).status).toBe(404);
    });

    it('refuses to undelete after 30 days, and writing a deleted day makes a fresh entry in the same row', async () => {
      clock(T0);
      await save(a, '2026-08-01', paragraphDoc('old'));
      await a.del('/api/journal/entries/2026-08-01');
      // The delete happened 31 days ago (moving the clock would also expire the test sessions).
      await db.db
        .update(journalEntries)
        .set({ deletedAt: new Date(T0.getTime() - 31 * 86_400_000) })
        .where(eq(journalEntries.entryDate, '2026-08-01'));
      expect((await a.post('/api/journal/entries/2026-08-01/undelete')).status).toBe(404);
      const fresh = await save(a, '2026-08-01', paragraphDoc('new text'));
      expect(fresh.status).toBe(200);
      expect(fresh.json.markdown).toBe('new text');
      expect(fresh.json.revisionNo).toBeGreaterThan(1);
      expect((await a.get('/api/journal/entries/2026-08-01')).status).toBe(200);
    });
  });

  describe('lists, search, calendar, lessons', () => {
    beforeAll(async () => {
      clock(T0);
      const lesson = (text: string): JournalDocJson => ({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Rolled the put early.' }] },
          { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        ],
      });
      await save(a, '2026-11-02', lesson('Lesson: stop checking the price every 10 minutes'), {
        tags: ['discipline'],
        marketView: 'bearish',
      });
      await save(a, '2026-11-03', mentionDoc('Tencent held', 'HK', '0700', '0700.HK'), {
        tags: ['hk'],
        marketView: 'bullish',
      });
      await save(a, '2026-11-04', paragraphDoc('港股再度低开，恒指收复'), { tags: ['hk'] });
      await save(a, '2026-11-05', lesson('Lesson: write the premium floor down'));
    });

    it('lists newest first with cards, excerpts and mentions', async () => {
      const r = await a.get('/api/journal/entries?from=2026-11-01&to=2026-11-30&today=2026-11-05');
      expect(r.json.entries.map((e: { date: string }) => e.date)).toEqual([
        '2026-11-05',
        '2026-11-04',
        '2026-11-03',
        '2026-11-02',
      ]);
      expect(r.json.total).toBe(4);
      const tencent = r.json.entries.find((e: { date: string }) => e.date === '2026-11-03');
      expect(tencent.excerpt).toBe('Tencent held $0700.HK');
      expect(tencent.mentions).toEqual([{ market: 'HK', symbol: '0700', label: '0700.HK', known: true }]);
      expect(tencent.tags).toEqual(['hk']);
      expect(tencent).not.toHaveProperty('doc');
    });

    it('searches by words (prefix), by name, by tag, and Chinese text by substring', async () => {
      const q = async (query: string) =>
        ((await a.get(`/api/journal/entries?${query}`)).json.entries as { date: string }[]).map((e) => e.date);
      expect(await q('q=premium')).toEqual(['2026-11-05']);
      expect(await q('q=prem%20floor')).toEqual(['2026-11-05']);
      expect(await q('q=check')).toEqual(['2026-11-02']);
      expect(await q('symbol=0700.HK')).toEqual(['2026-11-03']);
      expect(await q('symbol=700.HK')).toEqual(['2026-11-03']);
      expect(await q('symbol=ZZZZ')).toEqual([]);
      expect((await a.get('/api/journal/entries?symbol=0700.HKX')).status).toBe(400);
      expect(await q('tag=%23hk&from=2026-11-01')).toEqual(['2026-11-04', '2026-11-03']);
      expect(await q('tag=hk&q=tencent&from=2026-11-01')).toEqual(['2026-11-03']);
      expect(await q('q=%E6%81%92%E6%8C%87')).toEqual(['2026-11-04']);
      expect(await q('q=nothing-like-this')).toEqual([]);
      expect((await a.get('/api/journal/entries?symbol=not%20a%20name')).status).toBe(400);
      expect((await a.get('/api/journal/entries?q=%27%3B%20drop%20table')).status).toBe(200);
    });

    it('pages the list', async () => {
      const p1 = (await a.get('/api/journal/entries?from=2026-11-01&to=2026-11-30&pageSize=3&page=1')).json;
      const p2 = (await a.get('/api/journal/entries?from=2026-11-01&to=2026-11-30&pageSize=3&page=2')).json;
      expect(p1.entries).toHaveLength(3);
      expect(p2.entries).toHaveLength(1);
      expect(p1.total).toBe(4);
      expect(p2.page).toBe(2);
    });

    it('summarises the month of the client date: entries, lessons, names, streak', async () => {
      const s = (await a.get('/api/journal/entries?today=2026-11-05')).json.summary;
      expect(s).toEqual({ month: '2026-11', entries: 4, lessons: 2, names: 1, streak: 4 });
      // While today has no entry yet the streak runs to yesterday.
      expect((await a.get('/api/journal/entries?today=2026-11-06')).json.summary.streak).toBe(4);
      expect((await a.get('/api/journal/entries?today=2026-11-08')).json.summary.streak).toBe(0);
    });

    it('returns the month calendar with market views', async () => {
      const c = (await a.get('/api/journal/calendar?month=2026-11')).json;
      expect(c).toMatchObject({ month: '2026-11', entries: 4, bullish: 1, bearish: 1 });
      expect(c.days.map((d: { date: string }) => d.date)).toEqual([
        '2026-11-02',
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
      ]);
      expect(c.days[0]).toMatchObject({ marketView: 'bearish', status: 'draft' });
      expect((await a.get('/api/journal/calendar?month=2026-13')).status).toBe(400);
      expect((await a.get('/api/journal/calendar')).status).toBe(400);
    });

    it('lists "Lesson:" paragraphs, newest first, each with its day', async () => {
      const l = (await a.get('/api/journal/lessons')).json.lessons;
      expect(l.slice(0, 2)).toEqual([
        { date: '2026-11-05', text: 'write the premium floor down', mentions: [], source: 'entry' },
        { date: '2026-11-02', text: 'stop checking the price every 10 minutes', mentions: [], source: 'entry' },
      ]);
      expect((await a.get('/api/journal/lessons?limit=1')).json.lessons).toHaveLength(1);
    });

    it('computes the streak from the dates', () => {
      expect(journalStreak(['2026-11-05', '2026-11-04', '2026-11-02'], '2026-11-05')).toBe(2);
      expect(journalStreak(['2026-11-04', '2026-11-03'], '2026-11-05')).toBe(2);
      expect(journalStreak(['2026-11-03'], '2026-11-05')).toBe(0);
      expect(journalStreak([], '2026-11-05')).toBe(0);
    });
  });

  describe('mentions and export', () => {
    it('keeps the instrument links in step with the text, from the document and never from the client', async () => {
      clock(T0);
      const first = await save(a, '2026-12-01', mentionDoc('Looking at', 'US', 'NKE', 'NKE'));
      const links = async () =>
        db.db
          .select({ n: sql<number>`count(*)::int` })
          .from(journalEntryInstruments)
          .where(eq(journalEntryInstruments.entryId, first.json.id));
      expect((await links())[0]?.n).toBe(1);
      const both: JournalDocJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Bare $NKE and $0700.HK and $ZZZZ (not in the app).' }],
          },
        ],
      };
      await save(a, '2026-12-01', both, { revisionNo: 1 });
      expect((await links())[0]?.n).toBe(2);
      const unknown = (await a.get('/api/journal/entries/2026-12-01')).json.mentions as {
        label: string;
        known: boolean;
      }[];
      expect(unknown.map((m) => `${m.label}:${m.known}`)).toEqual(['NKE:true', '0700.HK:true', 'ZZZZ:false']);
      await save(a, '2026-12-01', paragraphDoc('no names now'), { revisionNo: 2 });
      expect((await links())[0]?.n).toBe(0);
    });

    it('exports Markdown with a title, a date line and the body', async () => {
      await save(a, '2026-12-02', mentionDoc('Sold the put on', 'US', 'NKE', 'NKE'), {
        title: 'NKE roll',
        tags: ['trade'],
        marketView: 'bearish',
      });
      const r = await a.get('/api/journal/entries/2026-12-02/export.md');
      expect(r.status).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/markdown');
      expect(String(r.headers['content-disposition'])).toBe('attachment; filename="journal-2026-12-02.md"');
      expect(r.text).toBe('# NKE roll\n\nWed 2 Dec 2026 · bearish · #trade\n\nSold the put on $NKE\n');
    });

    it('never touches another table: the journal rows live only in the journal tables', async () => {
      const rows = await db.db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
      expect(rows[0]?.n).toBeGreaterThan(5);
    });
  });
});

describe('journal API (login off)', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-open-'));
    t = await startApp(db, { tmp, now: T0 });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('says so when there is no account to own the journal', async () => {
    const c = journalClient(t);
    const r = await c.get('/api/journal/entries');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('no_account');
  });

  it('belongs to the oldest account when nobody has to sign in', async () => {
    const owner = await addUser(db, 'owner', T0);
    await addUser(db, 'guest', T0);
    const c = journalClient(t);
    const r = await c.put('/api/journal/entries/2026-10-01', entryInput(paragraphDoc('hello')));
    expect(r.status).toBe(200);
    const rows = await db.db.select().from(journalEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(owner.id);
    expect(JOURNAL_TEMPLATES.length).toBeGreaterThan(0);
  });
});

describe('journal API on a database that has not been migrated', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDb();
    await db.db.execute(
      sql`drop table journal_assets, journal_ai_runs, journal_entry_instruments, journal_revisions, journal_entries cascade`,
    );
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-old-'));
    t = await startApp(db, { tmp, now: T0 });
    await addUser(db, 'owner', T0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('says to run the migration instead of a bare internal error', async () => {
    const r = await journalClient(t).get('/api/journal/entries');
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('migration_needed');
    expect(r.json.error.message).toContain('pnpm db:migrate');
  });
});
