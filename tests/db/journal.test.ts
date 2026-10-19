import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findInstrumentIds,
  getJournalEntry,
  insertJournalEntry,
  insertJournalRevision,
  latestJournalRevision,
  listJournalCards,
  patchJournalEntry,
  purgeDeletedJournalEntries,
  replaceEntryInstruments,
  soleOwnerId,
} from '../../src/db/journal';
import { appUsers, instruments, journalEntries, journalEntryInstruments, journalRevisions } from '../../src/db/schema';
import { deriveFromDoc } from '../../src/journal';
import { stableJson } from '../../src/server/services/journal-service';
import { createTestDb, type TestDb } from '../helpers/test-db';
import { KITCHEN_SINK } from '../journal/fixtures';

const NOW = new Date('2026-10-13T08:00:00Z');

describe('journal tables', () => {
  let db: TestDb;
  let alice = '';
  let bob = '';
  beforeAll(async () => {
    db = await createTestDb();
    const users = await db.db
      .insert(appUsers)
      .values([
        { username: 'alice', email: 'alice@example.com', createdAt: new Date('2026-01-01T00:00:00Z') },
        { username: 'bob', email: 'bob@example.com', createdAt: new Date('2026-02-01T00:00:00Z') },
      ])
      .returning();
    alice = (users[0] as { id: string }).id;
    bob = (users[1] as { id: string }).id;
  });
  afterAll(async () => {
    await db.drop();
  });

  const entry = (userId: string, date: string, over: Partial<Parameters<typeof insertJournalEntry>[1]> = {}) => {
    const derived = deriveFromDoc(KITCHEN_SINK);
    return insertJournalEntry(db.db, {
      userId,
      entryDate: date,
      title: 'Evening review',
      template: 'evening',
      marketView: 'neutral',
      tags: ['hk', 'roll-rule'],
      doc: KITCHEN_SINK,
      markdown: derived.markdown,
      plain: derived.plain,
      wordCount: derived.wordCount,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    });
  };

  it('round-trips a document, its tags and the derived columns, and fills the search vector', async () => {
    const row = await entry(alice, '2026-10-01');
    expect(row.revisionNo).toBe(1);
    expect(row.status).toBe('draft');
    expect(row.deletedAt).toBeNull();
    const back = await getJournalEntry(db.db, alice, '2026-10-01');
    expect(back?.entryDate).toBe('2026-10-01');
    expect(back?.tags).toEqual(['hk', 'roll-rule']);
    expect(stableJson(back?.doc)).toBe(stableJson(KITCHEN_SINK));
    expect(back?.wordCount).toBeGreaterThan(20);
    const hit = await db.db.execute<{ n: number }>(
      sql`select count(*)::int as n from journal_entries where search @@ to_tsquery('english', 'roll:* & nke:*') and id = ${row.id}`,
    );
    expect(hit.rows[0]?.n).toBe(1);
    const title = await db.db.execute<{ n: number }>(
      sql`select count(*)::int as n from journal_entries where search @@ to_tsquery('english', 'evening') and id = ${row.id}`,
    );
    expect(title.rows[0]?.n).toBe(1);
  });

  it('allows one entry per user per day, and the same day for another user', async () => {
    await entry(alice, '2026-10-02');
    await expect(entry(alice, '2026-10-02')).rejects.toThrow();
    await expect(entry(bob, '2026-10-02')).resolves.toBeTruthy();
  });

  it("never returns another user's row, and hides soft-deleted rows unless asked", async () => {
    expect(await getJournalEntry(db.db, bob, '2026-10-01')).toBeNull();
    const row = await entry(alice, '2026-10-03');
    await patchJournalEntry(db.db, row.id, { deletedAt: NOW });
    expect(await getJournalEntry(db.db, alice, '2026-10-03')).toBeNull();
    expect((await getJournalEntry(db.db, alice, '2026-10-03', { includeDeleted: true }))?.id).toBe(row.id);
    const list = await listJournalCards(db.db, alice, { limit: 50, offset: 0 });
    expect(list.rows.map((r) => r.entryDate)).not.toContain('2026-10-03');
    expect(list.rows.map((r) => r.entryDate)).toEqual(['2026-10-02', '2026-10-01']);
    const bobs = await listJournalCards(db.db, bob, { limit: 50, offset: 0 });
    expect(bobs.rows.map((r) => r.entryDate)).toEqual(['2026-10-02']);
  });

  it('bumps the concurrency token on every patch', async () => {
    const row = await entry(alice, '2026-10-04');
    const a = await patchJournalEntry(db.db, row.id, { title: 'one' });
    const b = await patchJournalEntry(db.db, row.id, { title: 'two' });
    expect([row.revisionNo, a.revisionNo, b.revisionNo]).toEqual([1, 2, 3]);
  });

  it('rejects values the check constraints forbid', async () => {
    await expect(entry(alice, '2026-10-05', { marketView: 'sideways' })).rejects.toThrow();
    await expect(entry(alice, '2026-10-06', { template: 'poem' })).rejects.toThrow();
    const row = await entry(alice, '2026-10-07');
    await expect(patchJournalEntry(db.db, row.id, { status: 'archived' })).rejects.toThrow();
    await expect(
      insertJournalRevision(db.db, {
        entryId: row.id,
        revisionNo: 1,
        doc: KITCHEN_SINK,
        markdown: 'x',
        source: 'guess' as never,
        createdAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('keeps a revision per number and finds the latest', async () => {
    const row = await entry(alice, '2026-10-08');
    for (const no of [1, 2, 3])
      await insertJournalRevision(db.db, {
        entryId: row.id,
        revisionNo: no,
        doc: KITCHEN_SINK,
        markdown: `r${no}`,
        source: 'user',
        createdAt: new Date(NOW.getTime() + no * 1000),
      });
    expect((await latestJournalRevision(db.db, row.id))?.markdown).toBe('r3');
    await expect(
      insertJournalRevision(db.db, {
        entryId: row.id,
        revisionNo: 3,
        doc: KITCHEN_SINK,
        markdown: 'dup',
        source: 'user',
        createdAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('stores the instruments an entry mentions, replacing the set each time', async () => {
    const inst = await db.db
      .insert(instruments)
      .values([
        { market: 'US', symbol: 'NKE', currency: 'USD' },
        { market: 'HK', symbol: '0700', currency: 'HKD' },
      ])
      .returning();
    const [nke, tencent] = inst as { id: number }[];
    const row = await entry(alice, '2026-10-09');
    const found = await findInstrumentIds(db.db, [
      { market: 'US', symbol: 'NKE' },
      { market: 'HK', symbol: '0700' },
      { market: 'US', symbol: 'ZZZZ' },
    ]);
    expect([...found.keys()].sort()).toEqual(['HK:0700', 'US:NKE']);
    await replaceEntryInstruments(db.db, row.id, [...found.values()]);
    const rows = await db.db.select().from(journalEntryInstruments).where(eq(journalEntryInstruments.entryId, row.id));
    expect(rows.map((r) => r.instrumentId).sort()).toEqual(
      [(nke as { id: number }).id, (tencent as { id: number }).id].sort(),
    );
    await replaceEntryInstruments(db.db, row.id, []);
    expect(
      await db.db.select().from(journalEntryInstruments).where(eq(journalEntryInstruments.entryId, row.id)),
    ).toEqual([]);
  });

  it('purges only entries soft-deleted more than 30 days ago', async () => {
    const old = await entry(alice, '2026-09-01');
    const recent = await entry(alice, '2026-09-02');
    const live = await entry(alice, '2026-09-03');
    await patchJournalEntry(db.db, old.id, { deletedAt: new Date(NOW.getTime() - 31 * 86_400_000) });
    await patchJournalEntry(db.db, recent.id, { deletedAt: new Date(NOW.getTime() - 29 * 86_400_000) });
    expect(await purgeDeletedJournalEntries(db.db, NOW)).toBe(1);
    const left = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.userId, alice));
    expect(left.map((r) => r.id)).toContain(recent.id);
    expect(left.map((r) => r.id)).toContain(live.id);
    expect(left.map((r) => r.id)).not.toContain(old.id);
  });

  it('names the oldest account as the owner', async () => {
    expect(await soleOwnerId(db.db)).toBe(alice);
  });

  it('removes entries, revisions and mentions with the account', async () => {
    const [temp] = await db.db.insert(appUsers).values({ username: 'temp', email: 'temp@example.com' }).returning();
    const id = (temp as { id: string }).id;
    const row = await entry(id, '2026-10-10');
    await insertJournalRevision(db.db, {
      entryId: row.id,
      revisionNo: 1,
      doc: KITCHEN_SINK,
      markdown: 'x',
      source: 'user',
      createdAt: NOW,
    });
    await db.db.delete(appUsers).where(eq(appUsers.id, id));
    expect(await db.db.select().from(journalEntries).where(eq(journalEntries.id, row.id))).toEqual([]);
    expect(await db.db.select().from(journalRevisions).where(eq(journalRevisions.entryId, row.id))).toEqual([]);
  });
});
