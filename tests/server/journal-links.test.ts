import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertInstrument } from '../../src/db/repos';
import type { JournalDocJson } from '../../src/journal';
import { startApp, type TestApp } from '../helpers/app';
import { addUser, entryInput, journalClient, mentionDoc, paragraphDoc, type TestUser } from '../helpers/journal';
import { createTestDb, type TestDb } from '../helpers/test-db';

const T0 = new Date('2026-10-13T08:00:00Z');

describe('journal cross-links: Research notes, lessons, snapshots', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let a: ReturnType<typeof journalClient>;
  let b: ReturnType<typeof journalClient>;
  let anon: ReturnType<typeof journalClient>;

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-journal-links-'));
    t = await startApp(db, { tmp, auth: {}, now: T0 });
    alice = await addUser(db, 'alice', T0);
    bob = await addUser(db, 'bob', T0);
    a = journalClient(t, alice.cookie);
    b = journalClient(t, bob.cookie);
    anon = journalClient(t);
    await upsertInstrument(db.db, { market: 'US', symbol: 'NKE' });
    await upsertInstrument(db.db, { market: 'US', symbol: 'KO' });
    await upsertInstrument(db.db, { market: 'HK', symbol: '0700' });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const save = (c: typeof a, date: string, doc: JournalDocJson, over = {}) =>
    c.put(`/api/journal/entries/${date}`, entryInput(doc, over));
  const notes = async (c: typeof a, path: string) => (await c.get(`/api/stocks/${path}/journal`)).json;

  describe('"Your notes" on a Research page', () => {
    beforeAll(async () => {
      await save(a, '2026-10-01', mentionDoc('Sold the 65 put on', 'US', 'NKE', 'NKE'), { title: 'NKE roll plan' });
      await save(a, '2026-10-02', paragraphDoc('Nothing happened with anything'));
      await save(a, '2026-10-03', mentionDoc('Results due for', 'US', 'NKE', 'NKE'));
      await save(a, '2026-10-04', mentionDoc('Watching', 'HK', '0700', '0700.HK'), { marketView: 'bullish' });
      await save(a, '2026-10-05', {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Market' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Bare mention of $NKE here, not a mark.' }] },
        ],
      });
      await save(a, '2026-10-06', mentionDoc('Rolled', 'US', 'NKE', 'NKE'), { title: 'Newest NKE note' });
      await save(b, '2026-10-07', mentionDoc('Bob thinks about', 'US', 'NKE', 'NKE'), { title: 'bob private' });
    });

    it('lists the last three entries that mention the name, newest first, each with the line that names it', async () => {
      const r = await notes(a, 'US/NKE');
      expect(r.entries.map((e: { date: string }) => e.date)).toEqual(['2026-10-06', '2026-10-05', '2026-10-03']);
      expect(r.entries[0]).toEqual({
        date: '2026-10-06',
        title: 'Newest NKE note',
        marketView: 'neutral',
        snippet: 'Rolled NKE',
      });
      expect(r.entries[1].snippet).toBe('Bare mention of NKE here, not a mark.');
      expect(r.entries[2].title).toBeNull();
    });

    it('works for an HK name however the code is written, and keeps the market view', async () => {
      for (const path of ['HK/0700', 'HK/0700.HK', 'HK/700', 'hk/0700.hk']) {
        const r = await notes(a, path);
        expect(r.entries, path).toEqual([
          { date: '2026-10-04', title: null, marketView: 'bullish', snippet: 'Watching 0700.HK' },
        ]);
      }
    });

    it('is scoped to the signed-in user in both directions', async () => {
      const mine = await notes(a, 'US/NKE');
      expect(JSON.stringify(mine)).not.toContain('bob');
      const bobs = await notes(b, 'US/NKE');
      expect(bobs.entries).toEqual([
        { date: '2026-10-07', title: 'bob private', marketView: 'neutral', snippet: 'Bob thinks about NKE' },
      ]);
      expect((await notes(b, 'HK/0700')).entries).toEqual([]);
    });

    it('follows the text: a name taken out disappears, a deleted entry disappears, a restored one comes back', async () => {
      const first = (await a.get('/api/journal/entries/2026-10-06')).json;
      await save(a, '2026-10-06', paragraphDoc('No names today'), { revisionNo: first.revisionNo });
      expect((await notes(a, 'US/NKE')).entries.map((e: { date: string }) => e.date)).toEqual([
        '2026-10-05',
        '2026-10-03',
        '2026-10-01',
      ]);
      await a.del('/api/journal/entries/2026-10-05');
      expect((await notes(a, 'US/NKE')).entries.map((e: { date: string }) => e.date)).toEqual([
        '2026-10-03',
        '2026-10-01',
      ]);
      await a.post('/api/journal/entries/2026-10-05/undelete');
      expect((await notes(a, 'US/NKE')).entries.map((e: { date: string }) => e.date)).toEqual([
        '2026-10-05',
        '2026-10-03',
        '2026-10-01',
      ]);
    });

    it('has nothing to say about a name that is not in the app, a name never mentioned, or a bad market', async () => {
      expect((await notes(a, 'US/ZZZZ')).entries).toEqual([]);
      expect((await notes(a, 'US/KO')).entries).toEqual([]);
      expect((await a.get('/api/stocks/JP/NKE/journal')).status).toBe(400);
      expect((await a.get('/api/stocks/HK/not-a-code/journal')).status).toBe(400);
    });

    it('is behind the login, encoded paths included', async () => {
      expect((await anon.get('/api/stocks/US/NKE/journal')).status).toBe(401);
      expect((await anon.get('/%61pi/stocks/US/NKE/journal')).status).toBe(401);
      expect((await anon.get('/api/stocks/US/%4eKE/journal')).status).toBe(401);
    });
  });

  describe('Lessons', () => {
    it('finds "Lesson:" paragraphs and the bullets of an accepted "Lessons & actions" section, never its to-dos', async () => {
      const doc: JournalDocJson = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Rolled early.' }] },
          {
            type: 'blockquote',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lesson: roll at strike plus 5%' }] }],
          },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Lessons & actions (AI draft)' }] },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Rules beat feelings on ', marks: [{ type: 'bold' }] },
                      {
                        type: 'text',
                        text: 'NKE',
                        marks: [{ type: 'stockMention', attrs: { market: 'US', symbol: 'NKE' } }],
                      },
                    ],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Premium has a floor' }] }],
              },
            ],
          },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: false },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Set an alert at 68' }] }],
              },
            ],
          },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Tomorrow' }] },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'not a lesson' }] }] },
            ],
          },
        ],
      };
      expect((await save(a, '2026-11-10', doc)).status).toBe(200);
      const r = (await a.get('/api/journal/lessons')).json.lessons as {
        date: string;
        text: string;
        source: string;
        mentions: { label: string }[];
      }[];
      const day = r.filter((l) => l.date === '2026-11-10');
      expect(day.map((l) => `${l.source}: ${l.text}`)).toEqual([
        'entry: roll at strike plus 5%',
        'ai: Rules beat feelings on NKE',
        'ai: Premium has a floor',
      ]);
      expect(day[1]?.mentions.map((m) => m.label)).toEqual(['NKE']);
      expect((await a.get('/api/journal/entries?today=2026-11-10')).json.summary.lessons).toBe(3);
      expect(JSON.stringify((await b.get('/api/journal/lessons')).json)).not.toContain('Premium has a floor');
    });
  });

  describe('snapshots', () => {
    it('inserts what the endpoint returned as a snapshot node, saves it, and finds the names in it', async () => {
      const pos = await a.post('/api/positions', {
        symbol: 'KO',
        market: 'US',
        strike: 60,
        expiry: '2026-11-20',
        contracts: 2,
        price: 0.85,
        date: '2026-10-09',
      });
      expect(pos.status).toBe(201);
      const snap = (await a.get('/api/journal/snapshot?kind=positions')).json;
      expect(snap.rows.find((r: string[]) => r[0] === 'KO')).toBeTruthy();
      const doc: JournalDocJson = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Where I stand' }] },
          { type: 'snapshot', attrs: snap },
        ],
      };
      const saved = await save(a, '2026-11-11', doc);
      expect(saved.status, saved.text.slice(0, 200)).toBe(200);
      expect(saved.json.markdown).toContain('<!-- snapshot:positions:');
      expect(saved.json.markdown).toContain('| KO | 60 |');
      // The words are the author's: the snapshot adds none.
      expect(saved.json.wordCount).toBe(3);
      const found = (await a.get('/api/journal/entries?q=ko&from=2026-11-11&to=2026-11-11')).json;
      expect(found.total).toBe(1);
      // It is a copy: closing the position later does not change what the entry shows.
      await a.post(`/api/positions/${pos.json.id}/close`, { kind: 'expired', date: '2026-11-20' });
      expect((await a.get('/api/journal/entries/2026-11-11')).json.markdown).toContain('| KO | 60 |');
    });

    it('answers a clear error when the scan cannot be read, and refuses a snapshot node with a bad table', async () => {
      const scan = await a.get('/api/journal/snapshot?kind=scan');
      expect(scan.status).toBe(400);
      expect(scan.json.error.code).toBe('equity_not_set');
      const bad = await save(a, '2026-11-12', {
        type: 'doc',
        content: [
          {
            type: 'snapshot',
            attrs: {
              kind: 'positions',
              asOf: '2026-11-12T10:00',
              title: 'x',
              columns: ['a'],
              align: ['l'],
              rows: [[1]],
            },
          },
        ],
      });
      expect(bad.status).toBe(400);
    });
  });
});
