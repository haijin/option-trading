/**
 * The daily journal: one diary entry per user per day (docs/designs/daily-journal.md).
 * Every method takes the signed-in user's id and every query filters by it. The server accepts ProseMirror JSON only,
 * validates it against the fixed schema (src/journal) and derives the Markdown, search text, word count and mentions
 * itself. Nothing here is read by a skill, the scanner or a backtest.
 */
import { createHash } from 'node:crypto';
import { addDays, endOfMonth, isISODate } from '../../core/dates';
import {
  clearJournalHistory,
  countJournalRevisions,
  findInstrumentIds,
  getJournalEntry,
  getJournalRevision,
  insertJournalEntry,
  insertJournalRevision,
  JOURNAL_UNDELETE_DAYS,
  type JournalCardRow,
  type JournalEntryRow,
  type JournalRevisionRow,
  journalCardsMentioning,
  journalDaysBetween,
  journalLessonSources,
  knownInstrumentKeys,
  latestJournalRevision,
  linkJournalAssets,
  listJournalCards,
  listJournalRevisions,
  lockJournalAiRunDecision,
  lockOwnedJournalAssets,
  modeOfJournalAiRun,
  newestAcceptedAi,
  ownedJournalAssetIds,
  patchJournalEntry,
  recentJournalDates,
  replaceEntryInstruments,
  soleOwnerId,
  updateJournalAiRun,
  updateJournalRevisionDoc,
} from '../../db/journal';
import { findInstrument } from '../../db/repos';
import {
  cleanTitle,
  deriveFromDoc,
  excerptOf,
  isStorableText,
  type JournalDerived,
  type JournalDocJson,
  type JournalMentionRef,
  lessonsOf,
  mentionLabel,
  mentionsOfMarkdown,
  normaliseTags,
  parseMention,
  snippetFor,
  validateJournalDoc,
} from '../../journal';
import type {
  JournalCalendarView,
  JournalCardView,
  JournalEntryInput,
  JournalEntryView,
  JournalLessonsView,
  JournalListView,
  JournalMarketView,
  JournalMentionView,
  JournalNotesView,
  JournalRevisionView,
  JournalStatus,
  JournalSummaryLineView,
  JournalTemplateId,
} from '../api-types';
import type { AuthService } from '../auth/service';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest, conflict, notFound } from '../errors';

/** A revision of typing is kept as one row until it is this old; then the next save starts a new row. */
export const REVISION_GAP_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface JournalListQuery {
  from?: string;
  to?: string;
  q?: string;
  symbol?: string;
  tag?: string;
  page?: number;
  pageSize?: number;
  today?: string;
}

/** Key-order-independent JSON, so a document read back from jsonb compares equal to the one that was sent. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** A hash of a document that does not depend on key order (jsonb returns keys in its own order). */
export function docHash(doc: unknown): string {
  return createHash('sha256').update(stableJson(doc)).digest('hex');
}

/** Consecutive days with an entry, ending today; while today has none, ending yesterday (the day is not over). */
export function journalStreak(datesNewestFirst: string[], today: string): number {
  const have = new Set(datesNewestFirst);
  let day = have.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (have.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

const monthOf = (day: string): string => day.slice(0, 7);

function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export class JournalService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly auth: AuthService | null,
  ) {}

  // ---------------------------------------------------------------------------------------------- who is asking
  /**
   * The account behind a request. With the login on it is the session's user (the gate has already refused anyone else);
   * with the login off there is no session, so the journal belongs to the oldest account.
   */
  async userId(cookie: string | undefined): Promise<string> {
    if (this.auth) {
      const user = await this.auth.userForCookie(cookie);
      if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
      return user.id;
    }
    const owner = await soleOwnerId(this.deps.db);
    if (!owner)
      throw new ApiError(
        409,
        'no_account',
        'The journal belongs to an account, and none exists yet. Create the owner account on the login page first.',
      );
    return owner;
  }

  // ---------------------------------------------------------------------------------------------- views
  private async mentionViews(refs: JournalMentionRef[]): Promise<Map<string, JournalMentionView>> {
    const known = await knownInstrumentKeys(this.deps.db, refs);
    const out = new Map<string, JournalMentionView>();
    for (const r of refs)
      out.set(`${r.market}:${r.symbol}`, {
        market: r.market,
        symbol: r.symbol,
        label: mentionLabel(r),
        known: known.has(`${r.market}:${r.symbol}`),
      });
    return out;
  }

  private cardOf(
    row: Pick<
      JournalCardRow,
      'entryDate' | 'title' | 'template' | 'marketView' | 'tags' | 'status' | 'wordCount' | 'markdown' | 'updatedAt'
    > & { aiPolished: boolean },
    views: Map<string, JournalMentionView>,
  ): JournalCardView {
    const mentions = mentionsOfMarkdown(row.markdown).flatMap((r) => {
      const v = views.get(`${r.market}:${r.symbol}`);
      return v ? [v] : [];
    });
    return {
      date: row.entryDate,
      title: row.title,
      template: row.template as JournalTemplateId | null,
      marketView: row.marketView as JournalMarketView,
      tags: row.tags,
      status: row.status as JournalStatus,
      wordCount: row.wordCount,
      excerpt: excerptOf(row.markdown),
      mentions,
      thumbnailAssetId: /!\[[^\]]*\]\(asset:([0-9a-f-]{36})\)/i.exec(row.markdown)?.[1]?.toLowerCase() ?? null,
      aiPolished: row.aiPolished,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async entryView(row: JournalEntryRow): Promise<JournalEntryView> {
    const db = this.deps.db;
    const [views, ai, count] = await Promise.all([
      this.mentionViews(mentionsOfMarkdown(row.markdown)),
      newestAcceptedAi(db, row.id),
      countJournalRevisions(db, row.id),
    ]);
    return {
      ...this.cardOf({ ...row, aiPolished: ai !== null }, views),
      id: row.id,
      doc: row.doc,
      markdown: row.markdown,
      revisionNo: row.revisionNo,
      createdAt: row.createdAt.toISOString(),
      revisionCount: count,
      lastAi: ai
        ? { mode: ai.aiRunId ? await modeOfJournalAiRun(db, ai.aiRunId) : null, at: ai.at.toISOString() }
        : null,
    };
  }

  private today(given?: string): string {
    return given ?? this.deps.now().toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------------------------------- reads
  private date(raw: string): string {
    if (!isISODate(raw) || raw < '2000-01-01' || raw > '2100-12-31')
      throw badRequest('invalid_date', 'the date must be a valid YYYY-MM-DD between 2000 and 2100');
    return raw;
  }

  async list(userId: string, q: JournalListQuery): Promise<JournalListView> {
    const db = this.deps.db;
    const page = Math.min(100_000, Math.max(1, Math.floor(q.page ?? 1)));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? DEFAULT_PAGE_SIZE)));
    for (const d of [q.from, q.to, q.today]) if (d !== undefined) this.date(d);
    let symbol: { market: 'US' | 'HK'; label: string } | undefined;
    if (q.symbol) {
      const ref = parseMention(q.symbol);
      if (!ref) throw badRequest('invalid_query', 'symbol must be a stock name such as NKE or 0700.HK');
      symbol = { market: ref.market, label: mentionLabel(ref) };
    }
    const tag = q.tag ? q.tag.trim().replace(/^#+/, '').toLowerCase() : undefined;
    const { rows, total } = await listJournalCards(db, userId, {
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.q?.trim() ? { q: q.q.trim().slice(0, 200) } : {}),
      ...(symbol ? { symbol } : {}),
      ...(tag ? { tag } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const views = await this.mentionViews(rows.flatMap((r) => mentionsOfMarkdown(r.markdown)));
    return {
      entries: rows.map((r) => this.cardOf(r, views)),
      total,
      page,
      pageSize,
      summary: await this.summary(userId, this.today(q.today)),
    };
  }

  private async summary(userId: string, today: string): Promise<JournalSummaryLineView> {
    const month = monthOf(today);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const [days, dates] = await Promise.all([
      journalDaysBetween(this.deps.db, userId, `${month}-01`, endOfMonth(y, m)),
      recentJournalDates(this.deps.db, userId),
    ]);
    const names = new Set<string>();
    let lessons = 0;
    for (const d of days) {
      lessons += lessonsOf(d.markdown).length;
      for (const r of mentionsOfMarkdown(d.markdown)) names.add(`${r.market}:${r.symbol}`);
    }
    return { month, entries: days.length, lessons, names: names.size, streak: journalStreak(dates, today) };
  }

  async get(userId: string, rawDate: string): Promise<JournalEntryView> {
    const row = await getJournalEntry(this.deps.db, userId, this.date(rawDate));
    if (!row) throw notFound('there is no entry for that day', 'entry_not_found');
    return this.entryView(row);
  }

  async calendar(userId: string, month: string): Promise<JournalCalendarView> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('invalid_query', 'month must be YYYY-MM');
    const [y, m] = month.split('-').map(Number) as [number, number];
    const rows = await journalDaysBetween(this.deps.db, userId, `${month}-01`, endOfMonth(y, m));
    return {
      month,
      days: rows.map((r) => ({
        date: r.entryDate,
        marketView: r.marketView as JournalMarketView,
        wordCount: r.wordCount,
        status: r.status as JournalStatus,
      })),
      entries: rows.length,
      bullish: rows.filter((r) => r.marketView === 'bullish').length,
      bearish: rows.filter((r) => r.marketView === 'bearish').length,
    };
  }

  async lessons(userId: string, limit = 50): Promise<JournalLessonsView> {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const sources = await journalLessonSources(this.deps.db, userId, n);
    const items = sources.flatMap((s) => lessonsOf(s.markdown).map((l) => ({ date: s.entryDate, ...l })));
    const views = await this.mentionViews(items.flatMap((i) => i.mentions));
    return {
      lessons: items.slice(0, n).map((i) => ({
        date: i.date,
        text: i.text,
        source: i.source,
        mentions: i.mentions.flatMap((r) => {
          const v = views.get(`${r.market}:${r.symbol}`);
          return v ? [v] : [];
        }),
      })),
    };
  }

  /**
   * "Your notes" on a stock's Research page: the newest entries of this user that mention it, each with the line that does.
   * A stock that is not in the app has no page, so it simply has no notes.
   */
  async notesFor(userId: string, market: 'US' | 'HK', symbol: string, limit = 3): Promise<JournalNotesView> {
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst) return { entries: [] };
    const label = mentionLabel({ market, symbol });
    const rows = await journalCardsMentioning(this.deps.db, userId, inst.id, Math.min(10, Math.max(1, limit)));
    return {
      entries: rows.map((r) => ({
        date: r.entryDate,
        title: r.title,
        marketView: r.marketView as JournalMarketView,
        snippet: snippetFor(r.markdown, label),
      })),
    };
  }

  // ---------------------------------------------------------------------------------------------- writes
  /** Does the stored entry already say what the client is sending? Then a repeated save changes nothing. */
  private sameContent(
    cur: JournalEntryRow,
    next: { title: string | null; template: string | null; marketView: string; tags: string[]; doc: JournalDocJson },
  ): boolean {
    return (
      cur.title === next.title &&
      cur.template === next.template &&
      cur.marketView === next.marketView &&
      stableJson(cur.tags) === stableJson(next.tags) &&
      stableJson(cur.doc) === stableJson(next.doc)
    );
  }

  /** Appends or follows a revision row for the state just written (see the rules in the schema comment). */
  private async recordRevision(
    tx: Parameters<Parameters<ServerDeps['db']['transaction']>[0]>[0],
    entryId: string,
    doc: JournalDocJson,
    markdown: string,
    source: JournalRevisionRow['source'],
    now: Date,
    aiRunId: string | null = null,
  ): Promise<{ previousRevisionNo: number | null }> {
    const latest = await latestJournalRevision(tx, entryId);
    if (
      source === 'user' &&
      latest?.source === 'user' &&
      now.getTime() - latest.createdAt.getTime() < REVISION_GAP_MS
    ) {
      await updateJournalRevisionDoc(tx, latest.id, { doc, markdown });
      return { previousRevisionNo: null };
    }
    await insertJournalRevision(tx, {
      entryId,
      revisionNo: (latest?.revisionNo ?? 0) + 1,
      doc,
      markdown,
      source: source as 'user' | 'ai_accepted' | 'restore' | 'template',
      aiRunId,
      createdAt: now,
    });
    return { previousRevisionNo: latest?.revisionNo ?? null };
  }

  /** The entry's row for another journal service (the AI rewrite starts from it). */
  async entryRow(userId: string, rawDate: string): Promise<JournalEntryRow> {
    return this.ownEntry(userId, rawDate);
  }

  /**
   * Puts an accepted AI suggestion into the entry: a revision of its own (the state before it stays as the revision
   * below), mentions and image links in step, and the run marked accepted, all in one transaction. The suggestion was
   * made from one exact document; if the entry was edited since, nothing is written and the author must ask again.
   */
  async applyAiResult(
    userId: string,
    rawDate: string,
    run: { id: string; inputHash: string },
    doc: JournalDocJson,
  ): Promise<{ entry: JournalEntryView; undoRevisionNo: number | null }> {
    const date = this.date(rawDate);
    const checked = validateJournalDoc(doc);
    if (!checked.ok)
      throw badRequest(
        'invalid_document',
        `The suggestion does not fit the journal format: ${checked.issues[0]?.message}`,
      );
    await this.checkFigures(userId, checked.assetIds);
    const derived = deriveFromDoc(checked.doc);
    let undo: number | null = null;
    const row = await this.deps.db.transaction(async (tx) => {
      await this.lockFigures(tx, userId, derived.assetIds);
      const cur = await getJournalEntry(tx, userId, date, { forUpdate: true });
      if (!cur) throw notFound('there is no entry for that day', 'entry_not_found');
      // Two accepts at once (or accept and reject): the run row is locked, the second sees the decision of the first.
      const decided = await lockJournalAiRunDecision(tx, run.id);
      if (decided !== null)
        throw conflict(
          'already_decided',
          decided ? 'This suggestion was already used.' : 'You already kept your version.',
        );
      if (docHash(cur.doc) !== run.inputHash)
        throw conflict(
          'entry_changed',
          'You edited this entry after the suggestion was made. Ask again to get one for what you have now.',
        );
      const now = this.deps.now();
      const entry = await patchJournalEntry(tx, cur.id, {
        doc: checked.doc,
        markdown: derived.markdown,
        plain: derived.plain,
        wordCount: derived.wordCount,
        updatedAt: now,
      });
      const rec = await this.recordRevision(tx, entry.id, checked.doc, derived.markdown, 'ai_accepted', now, run.id);
      undo = rec.previousRevisionNo;
      await this.syncMentions(tx, entry.id, derived);
      await linkJournalAssets(tx, userId, derived.assetIds, entry.id);
      await updateJournalAiRun(tx, run.id, { accepted: true });
      return entry;
    });
    return { entry: await this.entryView(row), undoRevisionNo: undo };
  }

  private async syncMentions(
    tx: Parameters<Parameters<ServerDeps['db']['transaction']>[0]>[0],
    entryId: string,
    derived: JournalDerived,
  ): Promise<void> {
    const found = await findInstrumentIds(tx, derived.mentions);
    await replaceEntryInstruments(tx, entryId, [...found.values()]);
  }

  /** Every image in a document must be one of this user's uploads (another user's id is rejected like an unknown one). */
  private async checkFigures(userId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) return;
    this.rejectMissing(assetIds, await ownedJournalAssetIds(this.deps.db, userId, assetIds));
  }

  /**
   * The same check inside the save's transaction, holding a share lock on the images until it commits: a delete of one of
   * them waits for the save and then finds it in use, so a save can never commit a figure whose file was just removed.
   */
  private async lockFigures(
    tx: Parameters<Parameters<ServerDeps['db']['transaction']>[0]>[0],
    userId: string,
    assetIds: string[],
  ): Promise<void> {
    if (assetIds.length === 0) return;
    this.rejectMissing(assetIds, await lockOwnedJournalAssets(tx, userId, assetIds));
  }

  private rejectMissing(assetIds: string[], mine: Set<string>): void {
    const bad = assetIds.filter((id) => !mine.has(id));
    if (bad.length > 0)
      throw badRequest('invalid_document', 'The entry has an image that is not in your journal. Upload it again.', [
        { path: '', message: `a figure refers to an image that is not yours or no longer exists: ${bad[0]}` },
      ]);
  }

  async put(userId: string, rawDate: string, input: JournalEntryInput): Promise<JournalEntryView> {
    const date = this.date(rawDate);
    const checked = validateJournalDoc(input.doc);
    if (!checked.ok)
      throw badRequest(
        'invalid_document',
        `The entry has content the journal does not accept: ${checked.issues[0]?.message ?? 'invalid'}`,
        checked.issues,
      );
    await this.checkFigures(userId, checked.assetIds);
    const tags = normaliseTags(input.tags);
    if (tags === null)
      throw badRequest('invalid_tags', 'Tags are words of letters, digits, - and _, at most 20 of them.');
    const title = cleanTitle(input.title);
    if (title !== null && (title.length > 200 || !isStorableText(title)))
      throw badRequest('invalid_title', 'The title is at most 200 characters, without control characters.');
    const derived = deriveFromDoc(checked.doc);
    const now = this.deps.now();
    const next = { title, template: input.template, marketView: input.marketView, tags, doc: checked.doc };
    const source = input.source === 'template' ? 'template' : 'user';

    const row = await this.writeEntry(userId, date, async (tx) => {
      await this.lockFigures(tx, userId, derived.assetIds);
      const cur = await getJournalEntry(tx, userId, date, { includeDeleted: true, forUpdate: true });
      const fields = {
        title,
        template: input.template,
        marketView: input.marketView,
        tags,
        doc: checked.doc,
        markdown: derived.markdown,
        plain: derived.plain,
        wordCount: derived.wordCount,
        updatedAt: now,
      };
      let entry: JournalEntryRow;
      if (!cur) {
        if (input.revisionNo !== null)
          throw conflict('revision_conflict', 'This entry no longer exists on the server.', {
            currentRevisionNo: null,
          });
        entry = await insertJournalEntry(tx, { userId, entryDate: date, ...fields, createdAt: now });
        await insertJournalRevision(tx, {
          entryId: entry.id,
          revisionNo: 1,
          doc: checked.doc,
          markdown: derived.markdown,
          source,
          createdAt: now,
        });
      } else {
        const deleted = cur.deletedAt !== null;
        const tokenOk = input.revisionNo === null ? deleted : input.revisionNo === cur.revisionNo;
        const same = !deleted && this.sameContent(cur, next);
        if (!tokenOk) {
          // A repeated save (pagehide and visibilitychange both fire) carries a stale token but says nothing new.
          if (same) return cur;
          throw conflict('revision_conflict', 'This entry changed on another device.', {
            currentRevisionNo: cur.revisionNo,
          });
        }
        if (same) return cur;
        // Writing a day that was deleted starts it afresh: the old text must not live on in History or old rewrites.
        if (deleted) await clearJournalHistory(tx, cur.id);
        entry = await patchJournalEntry(tx, cur.id, { ...fields, deletedAt: null });
        await this.recordRevision(tx, entry.id, checked.doc, derived.markdown, source, now);
      }
      await this.syncMentions(tx, entry.id, derived);
      await linkJournalAssets(tx, userId, derived.assetIds, entry.id);
      return entry;
    });
    return this.entryView(row);
  }

  /**
   * Runs a write transaction. Two devices saving a day that has no row yet both try to insert it; the loser hits the unique
   * key (23505) and is told what any stale writer is told: the entry changed, reload.
   */
  private async writeEntry(
    userId: string,
    date: string,
    body: (tx: Parameters<Parameters<ServerDeps['db']['transaction']>[0]>[0]) => Promise<JournalEntryRow>,
  ): Promise<JournalEntryRow> {
    try {
      return await this.deps.db.transaction(body);
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code !== '23505') throw err;
      const now = await getJournalEntry(this.deps.db, userId, date, { includeDeleted: true });
      throw conflict('revision_conflict', 'This entry changed on another device.', {
        currentRevisionNo: now?.revisionNo ?? null,
      });
    }
  }

  private async ownEntry(userId: string, rawDate: string): Promise<JournalEntryRow> {
    const row = await getJournalEntry(this.deps.db, userId, this.date(rawDate));
    if (!row) throw notFound('there is no entry for that day', 'entry_not_found');
    return row;
  }

  async setStatus(userId: string, rawDate: string, status: JournalStatus): Promise<JournalEntryView> {
    const row = await this.deps.db.transaction(async (tx) => {
      const cur = await getJournalEntry(tx, userId, this.date(rawDate), { forUpdate: true });
      if (!cur) throw notFound('there is no entry for that day', 'entry_not_found');
      if (cur.status === status) return cur;
      return patchJournalEntry(tx, cur.id, { status, updatedAt: this.deps.now() });
    });
    return this.entryView(row);
  }

  async remove(userId: string, rawDate: string): Promise<{ ok: true }> {
    await this.deps.db.transaction(async (tx) => {
      const cur = await getJournalEntry(tx, userId, this.date(rawDate), { forUpdate: true });
      if (!cur) throw notFound('there is no entry for that day', 'entry_not_found');
      const now = this.deps.now();
      await patchJournalEntry(tx, cur.id, { deletedAt: now, updatedAt: now });
    });
    return { ok: true };
  }

  async undelete(userId: string, rawDate: string): Promise<JournalEntryView> {
    const row = await this.deps.db.transaction(async (tx) => {
      const cur = await getJournalEntry(tx, userId, this.date(rawDate), { includeDeleted: true, forUpdate: true });
      const now = this.deps.now();
      const limit = JOURNAL_UNDELETE_DAYS * 24 * 3600 * 1000;
      if (!cur?.deletedAt || now.getTime() - cur.deletedAt.getTime() > limit)
        throw notFound('there is no deleted entry for that day to bring back', 'entry_not_found');
      return patchJournalEntry(tx, cur.id, { deletedAt: null, updatedAt: now });
    });
    return this.entryView(row);
  }

  // ---------------------------------------------------------------------------------------------- history
  private revisionLabel(row: JournalRevisionRow, earlier: JournalRevisionRow[], words: number): string {
    switch (row.source) {
      case 'template':
        return 'Applied a template';
      case 'ai_accepted':
        return 'AI suggestion accepted';
      case 'restore': {
        const same = earlier.find((e) => e.revisionNo < row.revisionNo && stableJson(e.doc) === stableJson(row.doc));
        return same ? `Restored revision ${same.revisionNo}` : 'Restored an earlier revision';
      }
      default:
        return row.revisionNo === 1 ? `Started · ${words} words` : `Typed ${words} words`;
    }
  }

  async revisions(userId: string, rawDate: string): Promise<JournalRevisionView[]> {
    const entry = await this.ownEntry(userId, rawDate);
    const rows = await listJournalRevisions(this.deps.db, entry.id);
    return rows.map((r, i) => {
      const words = deriveFromDoc(r.doc).wordCount;
      return {
        no: r.revisionNo,
        at: r.createdAt.toISOString(),
        source: r.source as JournalRevisionView['source'],
        label: this.revisionLabel(r, rows, words),
        wordCount: words,
        current: i === 0,
      };
    });
  }

  async restore(userId: string, rawDate: string, no: number): Promise<JournalEntryView> {
    const date = this.date(rawDate);
    const row = await this.deps.db.transaction(async (tx) => {
      const cur = await getJournalEntry(tx, userId, date, { forUpdate: true });
      if (!cur) throw notFound('there is no entry for that day', 'entry_not_found');
      const rev = await getJournalRevision(tx, cur.id, no);
      if (!rev) throw notFound('there is no such revision', 'revision_not_found');
      const checked = validateJournalDoc(rev.doc);
      if (!checked.ok)
        throw conflict('revision_unusable', 'That revision is no longer valid in the current document format.');
      const derived = deriveFromDoc(checked.doc);
      const mine = await lockOwnedJournalAssets(tx, userId, derived.assetIds);
      if (derived.assetIds.some((id) => !mine.has(id)))
        throw conflict('revision_unusable', 'That revision shows an image that has been deleted.');
      const now = this.deps.now();
      const entry = await patchJournalEntry(tx, cur.id, {
        doc: checked.doc,
        markdown: derived.markdown,
        plain: derived.plain,
        wordCount: derived.wordCount,
        updatedAt: now,
      });
      await this.recordRevision(tx, entry.id, checked.doc, derived.markdown, 'restore', now);
      await this.syncMentions(tx, entry.id, derived);
      await linkJournalAssets(tx, userId, derived.assetIds, entry.id);
      return entry;
    });
    return this.entryView(row);
  }

  // ---------------------------------------------------------------------------------------------- export
  /** `origin` (e.g. `https://app.example.com`) turns the image links into absolute addresses; opening one needs a signed-in browser. */
  async exportMarkdown(
    userId: string,
    rawDate: string,
    origin: string,
  ): Promise<{ filename: string; markdown: string }> {
    const entry = await this.ownEntry(userId, rawDate);
    const body = entry.markdown.replace(
      /\]\(asset:([0-9a-f-]{36})\)/gi,
      (_m, id: string) => `](${origin}/api/journal/assets/${id.toLowerCase()})`,
    );
    const head = [
      `# ${entry.title ?? longDate(entry.entryDate)}`,
      '',
      `${longDate(entry.entryDate)} · ${entry.marketView}${entry.tags.length ? ` · ${entry.tags.map((t) => `#${t}`).join(' ')}` : ''}`,
      '',
    ].join('\n');
    return { filename: `journal-${entry.entryDate}.md`, markdown: `${head}\n${body}\n` };
  }
}
