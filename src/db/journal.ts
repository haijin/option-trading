/**
 * Reads and writes of the daily journal tables (docs/designs/daily-journal.md). Every function takes the user id and
 * filters by it, so a row of another user can never be read or changed through here. Nothing in this file is used by
 * DataAccess, a skill, the scanner or a backtest: the journal is the user's own notes.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { JournalDocJson } from '../journal/types';
import type { Db, DbOrTx } from './client';
import {
  instruments,
  journalAiRuns,
  journalAssets,
  journalEntries,
  journalEntryInstruments,
  journalRevisions,
} from './schema';

export type JournalEntryRow = typeof journalEntries.$inferSelect;
export type JournalRevisionRow = typeof journalRevisions.$inferSelect;

/** Soft-deleted entries are kept this long (then removed by the purge in the scheduled jobs). */
export const JOURNAL_UNDELETE_DAYS = 30;

// ------------------------------------------------------------------------------------------------ one entry
/** The user's entry for a day. Soft-deleted rows are only returned with `includeDeleted`. */
export async function getJournalEntry(
  db: DbOrTx,
  userId: string,
  date: string,
  opts: { includeDeleted?: boolean; forUpdate?: boolean } = {},
): Promise<JournalEntryRow | null> {
  const base = db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.entryDate, date),
        opts.includeDeleted ? undefined : isNull(journalEntries.deletedAt),
      ),
    )
    .limit(1);
  const [row] = await (opts.forUpdate ? base.for('update') : base);
  return row ?? null;
}

export type NewJournalEntry = Pick<
  typeof journalEntries.$inferInsert,
  | 'userId'
  | 'entryDate'
  | 'title'
  | 'template'
  | 'marketView'
  | 'tags'
  | 'doc'
  | 'markdown'
  | 'plain'
  | 'wordCount'
  | 'createdAt'
  | 'updatedAt'
>;

export async function insertJournalEntry(db: DbOrTx, v: NewJournalEntry): Promise<JournalEntryRow> {
  const [row] = await db.insert(journalEntries).values(v).returning();
  return row as JournalEntryRow;
}

export type JournalEntryPatch = Partial<
  Pick<
    typeof journalEntries.$inferInsert,
    | 'title'
    | 'template'
    | 'marketView'
    | 'tags'
    | 'doc'
    | 'markdown'
    | 'plain'
    | 'wordCount'
    | 'status'
    | 'updatedAt'
    | 'deletedAt'
  >
>;

/** Applies a patch and bumps the concurrency token. The caller holds the row lock (see `forUpdate`). */
export async function patchJournalEntry(db: DbOrTx, id: string, patch: JournalEntryPatch): Promise<JournalEntryRow> {
  const [row] = await db
    .update(journalEntries)
    .set({ ...patch, revisionNo: sql`${journalEntries.revisionNo} + 1` })
    .where(eq(journalEntries.id, id))
    .returning();
  return row as JournalEntryRow;
}

// ------------------------------------------------------------------------------------------------ revisions
export async function latestJournalRevision(db: DbOrTx, entryId: string): Promise<JournalRevisionRow | null> {
  const [row] = await db
    .select()
    .from(journalRevisions)
    .where(eq(journalRevisions.entryId, entryId))
    .orderBy(desc(journalRevisions.revisionNo))
    .limit(1);
  return row ?? null;
}

export async function insertJournalRevision(
  db: DbOrTx,
  v: {
    entryId: string;
    revisionNo: number;
    doc: JournalDocJson;
    markdown: string;
    source: 'user' | 'ai_accepted' | 'restore' | 'template';
    aiRunId?: string | null;
    createdAt: Date;
  },
): Promise<void> {
  await db.insert(journalRevisions).values({ ...v, aiRunId: v.aiRunId ?? null });
}

/** The newest 'user' revision follows typing: its document is replaced in place (its time is when the stretch began). */
export async function updateJournalRevisionDoc(
  db: DbOrTx,
  id: string,
  v: { doc: JournalDocJson; markdown: string },
): Promise<void> {
  await db.update(journalRevisions).set(v).where(eq(journalRevisions.id, id));
}

export async function countJournalRevisions(db: DbOrTx, entryId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalRevisions)
    .where(eq(journalRevisions.entryId, entryId));
  return row?.n ?? 0;
}

export async function listJournalRevisions(db: DbOrTx, entryId: string): Promise<JournalRevisionRow[]> {
  return db
    .select()
    .from(journalRevisions)
    .where(eq(journalRevisions.entryId, entryId))
    .orderBy(desc(journalRevisions.revisionNo));
}

export async function getJournalRevision(db: DbOrTx, entryId: string, no: number): Promise<JournalRevisionRow | null> {
  const [row] = await db
    .select()
    .from(journalRevisions)
    .where(and(eq(journalRevisions.entryId, entryId), eq(journalRevisions.revisionNo, no)))
    .limit(1);
  return row ?? null;
}

export async function newestAcceptedAi(
  db: DbOrTx,
  entryId: string,
): Promise<{ at: Date; aiRunId: string | null } | null> {
  const [row] = await db
    .select({ at: journalRevisions.createdAt, aiRunId: journalRevisions.aiRunId })
    .from(journalRevisions)
    .where(and(eq(journalRevisions.entryId, entryId), eq(journalRevisions.source, 'ai_accepted')))
    .orderBy(desc(journalRevisions.revisionNo))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------------------------------------ mentions
/** Known instruments among the given names, keyed `US:NKE` / `HK:0700`. */
export async function findInstrumentIds(
  db: DbOrTx,
  refs: { market: 'US' | 'HK'; symbol: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (refs.length === 0) return out;
  const rows = await db
    .select({ id: instruments.id, market: instruments.market, symbol: instruments.symbol })
    .from(instruments)
    .where(
      or(...refs.map((r) => and(eq(instruments.market, r.market), eq(instruments.symbol, r.symbol)))) ?? sql`false`,
    );
  for (const r of rows) out.set(`${r.market}:${r.symbol}`, r.id);
  return out;
}

/** Replaces the entry's mention rows with exactly these instruments. */
export async function replaceEntryInstruments(db: DbOrTx, entryId: string, instrumentIds: number[]): Promise<void> {
  await db.delete(journalEntryInstruments).where(eq(journalEntryInstruments.entryId, entryId));
  if (instrumentIds.length > 0)
    await db
      .insert(journalEntryInstruments)
      .values([...new Set(instrumentIds)].map((instrumentId) => ({ entryId, instrumentId })));
}

// ------------------------------------------------------------------------------------------------ lists
export interface JournalListFilter {
  from?: string;
  to?: string;
  /** Words typed in the search box. */
  q?: string;
  symbol?: { market: 'US' | 'HK'; label: string };
  tag?: string;
  limit: number;
  offset: number;
}

export interface JournalCardRow {
  id: string;
  entryDate: string;
  title: string | null;
  template: string | null;
  marketView: string;
  tags: string[];
  status: string;
  wordCount: number;
  markdown: string;
  updatedAt: Date;
  aiPolished: boolean;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Search words become a prefix tsquery ("rol" finds "roll"); a text with non-ASCII letters (Chinese) falls back to substring. */
function queryCondition(q: string) {
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return undefined;
  if (words.some((w) => /\P{ASCII}/u.test(w))) {
    const like = `%${escapeLike(q.trim())}%`;
    return or(sql`${journalEntries.plain} ilike ${like}`, sql`coalesce(${journalEntries.title}, '') ilike ${like}`);
  }
  const tsquery = words.map((w) => `${w.toLowerCase()}:*`).join(' & ');
  return sql`${journalEntries.search} @@ to_tsquery('english', ${tsquery})`;
}

function listWhere(userId: string, f: Omit<JournalListFilter, 'limit' | 'offset'>) {
  return and(
    eq(journalEntries.userId, userId),
    isNull(journalEntries.deletedAt),
    f.from ? gte(journalEntries.entryDate, f.from) : undefined,
    f.to ? lte(journalEntries.entryDate, f.to) : undefined,
    f.q ? queryCondition(f.q) : undefined,
    f.tag ? sql`${journalEntries.tags} @> ARRAY[${f.tag}]::text[]` : undefined,
    f.symbol ? sql`${journalEntries.markdown} ~ ${`\\$${escapeRegex(f.symbol.label)}(?![A-Za-z0-9])`}` : undefined,
  );
}

/** The user's entries for the list: newest day first. */
export async function listJournalCards(
  db: DbOrTx,
  userId: string,
  f: JournalListFilter,
): Promise<{ rows: JournalCardRow[]; total: number }> {
  const where = listWhere(userId, f);
  const rows = await db
    .select({
      id: journalEntries.id,
      entryDate: journalEntries.entryDate,
      title: journalEntries.title,
      template: journalEntries.template,
      marketView: journalEntries.marketView,
      tags: journalEntries.tags,
      status: journalEntries.status,
      wordCount: journalEntries.wordCount,
      markdown: journalEntries.markdown,
      updatedAt: journalEntries.updatedAt,
      aiPolished: sql<boolean>`exists (select 1 from ${journalRevisions} r where r.entry_id = ${journalEntries.id} and r.source = 'ai_accepted')`,
    })
    .from(journalEntries)
    .where(where)
    .orderBy(desc(journalEntries.entryDate))
    .limit(f.limit)
    .offset(f.offset);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(where);
  return { rows, total: count?.n ?? 0 };
}

/** Day, market view and size of each entry in a date range (the month calendar). */
export async function journalDaysBetween(
  db: DbOrTx,
  userId: string,
  from: string,
  to: string,
): Promise<{ entryDate: string; marketView: string; wordCount: number; status: string; markdown: string }[]> {
  return db
    .select({
      entryDate: journalEntries.entryDate,
      marketView: journalEntries.marketView,
      wordCount: journalEntries.wordCount,
      status: journalEntries.status,
      markdown: journalEntries.markdown,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        isNull(journalEntries.deletedAt),
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
      ),
    )
    .orderBy(asc(journalEntries.entryDate));
}

/** The most recent days with an entry (for the streak), newest first. */
export async function recentJournalDates(db: DbOrTx, userId: string, limit = 400): Promise<string[]> {
  const rows = await db
    .select({ d: journalEntries.entryDate })
    .from(journalEntries)
    .where(and(eq(journalEntries.userId, userId), isNull(journalEntries.deletedAt)))
    .orderBy(desc(journalEntries.entryDate))
    .limit(limit);
  return rows.map((r) => r.d);
}

/** Entries whose Markdown contains a "Lesson:" line, newest first. */
export async function journalLessonSources(
  db: DbOrTx,
  userId: string,
  limit: number,
): Promise<{ entryDate: string; markdown: string }[]> {
  return db
    .select({ entryDate: journalEntries.entryDate, markdown: journalEntries.markdown })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        isNull(journalEntries.deletedAt),
        sql`${journalEntries.markdown} ~* '(^|\n)[ \t]*((> *)*lessons?:|## *lessons? *(&|and) *actions)'`,
      ),
    )
    .orderBy(desc(journalEntries.entryDate))
    .limit(limit);
}

/** Known names for a set of labels (`NKE`, `0700.HK`) in one query: which of them have a Research page. */
export async function knownInstrumentKeys(
  db: DbOrTx,
  refs: { market: 'US' | 'HK'; symbol: string }[],
): Promise<Set<string>> {
  const found = await findInstrumentIds(db, refs);
  return new Set(found.keys());
}

// ------------------------------------------------------------------------------------------------ ownership and purge
/** The oldest account: the owner when the login is switched off (there is no session to say who is writing). */
export async function soleOwnerId(db: DbOrTx): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`select id from app_users order by created_at asc, id asc limit 1`);
  return rows.rows[0]?.id ?? null;
}

/** Hard-deletes entries soft-deleted more than `JOURNAL_UNDELETE_DAYS` ago. Returns how many were removed. */
export async function purgeDeletedJournalEntries(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - JOURNAL_UNDELETE_DAYS * 24 * 3600 * 1000);
  const gone = await db
    .delete(journalEntries)
    .where(and(isNotNull(journalEntries.deletedAt), lt(journalEntries.deletedAt, cutoff)))
    .returning({ id: journalEntries.id });
  return gone.length;
}

/** Instrument ids mentioned by the entries of one user (used by tests and the Research card in stage J4). */
export async function entryIdsMentioning(db: DbOrTx, userId: string, instrumentId: number): Promise<string[]> {
  const rows = await db
    .select({ id: journalEntries.id })
    .from(journalEntryInstruments)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryInstruments.entryId))
    .where(
      and(
        eq(journalEntryInstruments.instrumentId, instrumentId),
        eq(journalEntries.userId, userId),
        isNull(journalEntries.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** The newest entries of one user that mention an instrument (from the links written on every save), newest day first. */
export async function journalCardsMentioning(
  db: DbOrTx,
  userId: string,
  instrumentId: number,
  limit: number,
): Promise<{ entryDate: string; title: string | null; marketView: string; markdown: string }[]> {
  return db
    .select({
      entryDate: journalEntries.entryDate,
      title: journalEntries.title,
      marketView: journalEntries.marketView,
      markdown: journalEntries.markdown,
    })
    .from(journalEntryInstruments)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryInstruments.entryId))
    .where(
      and(
        eq(journalEntryInstruments.instrumentId, instrumentId),
        eq(journalEntries.userId, userId),
        isNull(journalEntries.deletedAt),
      ),
    )
    .orderBy(desc(journalEntries.entryDate))
    .limit(limit);
}

// ------------------------------------------------------------------------------------------------ assets (images)
export type JournalAssetRow = typeof journalAssets.$inferSelect;

export async function insertJournalAsset(
  db: DbOrTx,
  v: {
    id: string;
    userId: string;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    sha256: string;
    path: string;
    createdAt: Date;
  },
): Promise<JournalAssetRow> {
  const [row] = await db.insert(journalAssets).values(v).returning();
  return row as JournalAssetRow;
}

/** The user's own asset; another user's id answers null exactly as an unknown id does. */
export async function getJournalAsset(db: DbOrTx, userId: string, id: string): Promise<JournalAssetRow | null> {
  const [row] = await db
    .select()
    .from(journalAssets)
    .where(and(eq(journalAssets.id, id), eq(journalAssets.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function findJournalAssetBySha(
  db: DbOrTx,
  userId: string,
  sha256: string,
): Promise<JournalAssetRow | null> {
  const [row] = await db
    .select()
    .from(journalAssets)
    .where(and(eq(journalAssets.userId, userId), eq(journalAssets.sha256, sha256)))
    .limit(1);
  return row ?? null;
}

/** Which of these ids are assets of this user. */
export async function ownedJournalAssetIds(db: DbOrTx, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: journalAssets.id })
    .from(journalAssets)
    .where(and(eq(journalAssets.userId, userId), inArray(journalAssets.id, ids)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Like `ownedJournalAssetIds`, but takes a share lock on the rows until the transaction ends. A save that shows an image
 * holds it, so a delete of that image (which locks the row for update) waits for the save and then sees it is in use.
 */
export async function lockOwnedJournalAssets(db: DbOrTx, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: journalAssets.id })
    .from(journalAssets)
    .where(and(eq(journalAssets.userId, userId), inArray(journalAssets.id, ids)))
    .for('share');
  return new Set(rows.map((r) => r.id));
}

/** A re-upload of an image that is already stored makes it new again, so the cleanup job does not take it a moment later. */
export async function touchJournalAsset(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db.update(journalAssets).set({ createdAt: now }).where(eq(journalAssets.id, id));
}

/** Records the first entry an asset was saved with. */
export async function linkJournalAssets(db: DbOrTx, userId: string, ids: string[], entryId: string): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(journalAssets)
    .set({ entryId })
    .where(and(eq(journalAssets.userId, userId), inArray(journalAssets.id, ids), isNull(journalAssets.entryId)));
}

const referenced = (assetAlias: string) =>
  sql.raw(`(
  exists (select 1 from journal_entries e where e.user_id = ${assetAlias}.user_id and strpos(lower(e.markdown), 'asset:' || ${assetAlias}.id::text) > 0)
  or exists (select 1 from journal_revisions r join journal_entries e on e.id = r.entry_id
             where e.user_id = ${assetAlias}.user_id and strpos(lower(r.markdown), 'asset:' || ${assetAlias}.id::text) > 0)
)`);

/** True when an entry (deleted or not) or one of its revisions still shows this image. */
export async function isJournalAssetReferenced(db: DbOrTx, userId: string, id: string): Promise<boolean> {
  const rows = await db.execute<{ used: boolean }>(
    sql`select ${referenced('a')} as used from journal_assets a where a.id = ${id} and a.user_id = ${userId}`,
  );
  return rows.rows[0]?.used === true;
}

export async function deleteJournalAsset(db: DbOrTx, userId: string, id: string): Promise<void> {
  await db.delete(journalAssets).where(and(eq(journalAssets.id, id), eq(journalAssets.userId, userId)));
}

/**
 * Deletes an asset row only if nothing shows it, in one transaction that first locks the row: a save that is adding the
 * image holds a share lock, so this waits for it and then finds the image in use. Returns the deleted row, 'in_use', or
 * null when there is no such asset (or, with `olderThan`, it is newer than that: it was just uploaded again).
 */
export async function deleteJournalAssetIfUnused(
  db: Db,
  userId: string,
  id: string,
  olderThan?: Date,
): Promise<JournalAssetRow | 'in_use' | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(journalAssets)
      .where(and(eq(journalAssets.id, id), eq(journalAssets.userId, userId)))
      .for('update');
    if (!row) return null;
    if (olderThan && row.createdAt >= olderThan) return null;
    // A new statement after the lock: it sees whatever the save that held the share lock committed.
    if (await isJournalAssetReferenced(tx, userId, id)) return 'in_use' as const;
    await tx.delete(journalAssets).where(eq(journalAssets.id, id));
    return row;
  });
}

/** An entry that is written again after it was deleted starts a new history: the old revisions and runs go. */
export async function clearJournalHistory(db: DbOrTx, entryId: string): Promise<void> {
  await db.delete(journalRevisions).where(eq(journalRevisions.entryId, entryId));
  await db.delete(journalAiRuns).where(eq(journalAiRuns.entryId, entryId));
}

/** Takes the row lock of a run and says whether the author already decided on it (accept and reject race). */
export async function lockJournalAiRunDecision(db: DbOrTx, id: string): Promise<boolean | null> {
  const [row] = await db
    .select({ accepted: journalAiRuns.accepted })
    .from(journalAiRuns)
    .where(eq(journalAiRuns.id, id))
    .for('update');
  return row ? row.accepted : null;
}

/** Serialises the per-user counters of the AI rewrite (daily cap) across concurrent requests. */
export async function lockJournalAiUser(db: DbOrTx, userId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`journal-ai:${userId}`}))`);
}

/** Assets older than the cutoff that no entry or revision shows (an upload that was never saved, a removed image). */
export async function orphanJournalAssets(db: DbOrTx, olderThan: Date): Promise<JournalAssetRow[]> {
  const rows = await db.execute<{
    id: string;
    user_id: string;
    entry_id: string | null;
    kind: string;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    sha256: string;
    path: string;
    created_at: Date;
  }>(
    sql`select a.* from journal_assets a where a.created_at < ${olderThan} and not ${referenced('a')} order by a.created_at`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    entryId: r.entry_id,
    kind: r.kind,
    mime: r.mime,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    sha256: r.sha256,
    path: r.path,
    createdAt: new Date(r.created_at),
  }));
}

// ------------------------------------------------------------------------------------------------ AI runs
export type JournalAiRunRow = typeof journalAiRuns.$inferSelect;

export type NewJournalAiRun = Pick<
  typeof journalAiRuns.$inferInsert,
  'entryId' | 'userId' | 'mode' | 'instruction' | 'withContext' | 'inputMarkdown' | 'locked' | 'inputHash' | 'createdAt'
>;

export async function insertJournalAiRun(db: DbOrTx, v: NewJournalAiRun): Promise<JournalAiRunRow> {
  const [row] = await db
    .insert(journalAiRuns)
    .values({ ...v, status: 'queued' })
    .returning();
  return row as JournalAiRunRow;
}

/** The user's own run; another user's id answers null exactly as an unknown id does. */
export async function getJournalAiRun(db: DbOrTx, userId: string, id: string): Promise<JournalAiRunRow | null> {
  const [row] = await db
    .select()
    .from(journalAiRuns)
    .where(and(eq(journalAiRuns.id, id), eq(journalAiRuns.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** By id only: for the worker, which already knows whose run it is. */
export async function getJournalAiRunById(db: DbOrTx, id: string): Promise<JournalAiRunRow | null> {
  const [row] = await db.select().from(journalAiRuns).where(eq(journalAiRuns.id, id)).limit(1);
  return row ?? null;
}

export type JournalAiRunPatch = Partial<
  Pick<
    typeof journalAiRuns.$inferInsert,
    | 'status'
    | 'outputMarkdown'
    | 'outputDoc'
    | 'accepted'
    | 'model'
    | 'costUsd'
    | 'durationMs'
    | 'error'
    | 'progress'
    | 'finishedAt'
  >
>;

export async function updateJournalAiRun(db: DbOrTx, id: string, patch: JournalAiRunPatch): Promise<void> {
  await db.update(journalAiRuns).set(patch).where(eq(journalAiRuns.id, id));
}

/** The newest run for an entry (any state), or null. */
export async function latestJournalAiRun(db: DbOrTx, userId: string, entryId: string): Promise<JournalAiRunRow | null> {
  const [row] = await db
    .select()
    .from(journalAiRuns)
    .where(and(eq(journalAiRuns.userId, userId), eq(journalAiRuns.entryId, entryId)))
    .orderBy(desc(journalAiRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** A queued or running run of this entry, if any (one at a time per entry). */
export async function activeJournalAiRun(db: DbOrTx, entryId: string): Promise<JournalAiRunRow | null> {
  const [row] = await db
    .select()
    .from(journalAiRuns)
    .where(and(eq(journalAiRuns.entryId, entryId), inArray(journalAiRuns.status, ['queued', 'running'])))
    .limit(1);
  return row ?? null;
}

/** Runs this user started since `since` (the daily cap counts every run, whatever became of it). */
export async function countJournalAiRunsSince(db: DbOrTx, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalAiRuns)
    .where(and(eq(journalAiRuns.userId, userId), gte(journalAiRuns.createdAt, since)));
  return row?.n ?? 0;
}

/** A process that died mid-run leaves queued or running rows behind; they would be polled forever. */
export async function failOrphanedJournalAiRuns(db: DbOrTx, reason: string, now: Date): Promise<void> {
  await db
    .update(journalAiRuns)
    .set({ status: 'failed', error: reason, finishedAt: now })
    .where(inArray(journalAiRuns.status, ['queued', 'running']));
}

/** Symbols of every stock in the app, so a bare `KO` in a diary text counts as a ticker. */
export async function allInstrumentSymbols(db: DbOrTx): Promise<Set<string>> {
  const rows = await db.select({ symbol: instruments.symbol }).from(instruments);
  return new Set(rows.map((r) => r.symbol));
}

/** The accepted run (and so the mode) behind an `ai_accepted` revision. */
export async function modeOfJournalAiRun(db: DbOrTx, id: string): Promise<string | null> {
  const [row] = await db
    .select({ mode: journalAiRuns.mode })
    .from(journalAiRuns)
    .where(eq(journalAiRuns.id, id))
    .limit(1);
  return row?.mode ?? null;
}

/** The day of an entry (any state), for a view of one of its runs. */
export async function getJournalEntryDate(db: DbOrTx, entryId: string): Promise<string | null> {
  const [row] = await db
    .select({ d: journalEntries.entryDate })
    .from(journalEntries)
    .where(eq(journalEntries.id, entryId))
    .limit(1);
  return row?.d ?? null;
}

/** queued -> running, only if it is still queued (a cancel may have got there first). */
export async function claimJournalAiRun(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db
    .update(journalAiRuns)
    .set({ status: 'running' })
    .where(and(eq(journalAiRuns.id, id), eq(journalAiRuns.status, 'queued')))
    .returning({ id: journalAiRuns.id });
  return rows.length > 0;
}
