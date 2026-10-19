/**
 * Reads and writes for the news page (docs/designs/latest-news.md). Display-only tables: nothing here touches a table a
 * skill reads, and no skill reads these. Hong Kong calendar days bucket the stories (`NEWS_TZ`).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import {
  NEWS_TZ,
  type NewsBullet,
  type NewsCitation,
  type NewsImpact,
  type NewsRule,
  type NewsSession,
  type NewsStanding,
  type NewsTapeItem,
} from '../core/news';
import { num } from '../core/util';
import type { DbOrTx } from './client';
import {
  corporateEvents,
  fxRates,
  instruments,
  marketRegime,
  newsBriefs,
  newsItems,
  positions,
  priceBars,
  recommendations,
  scanRuns,
  skillRuns,
} from './schema';

export interface NewNewsItem {
  instrumentId: number | null;
  source: string;
  url: string;
  title: string;
  snippet: string | null;
  publishedAt: Date;
  fetchedAt: Date;
  hash: string;
}

/** Inserts stories we have not seen (per name and url hash). Returns how many were new. */
export async function insertNewsItems(db: DbOrTx, rows: NewNewsItem[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    if (chunk.length === 0) continue;
    const res = await db.insert(newsItems).values(chunk).onConflictDoNothing().returning({ id: newsItems.id });
    inserted += res.length;
  }
  return inserted;
}

export interface NewsItemRow {
  id: number;
  instrumentId: number | null;
  market: Market | null;
  symbol: string | null;
  name: string | null;
  source: string;
  url: string;
  title: string;
  snippet: string | null;
  publishedAt: Date;
  fetchedAt: Date;
  impact: NewsImpact | null;
  summary: string | null;
  rules: NewsRule[] | null;
  standing: NewsStanding | null;
  confidence: number | null;
  knownAt: Date | null;
  model: string | null;
  costUsd: number | null;
}

const itemColumns = {
  id: newsItems.id,
  instrumentId: newsItems.instrumentId,
  market: instruments.market,
  symbol: instruments.symbol,
  name: instruments.name,
  source: newsItems.source,
  url: newsItems.url,
  title: newsItems.title,
  snippet: newsItems.snippet,
  publishedAt: newsItems.publishedAt,
  fetchedAt: newsItems.fetchedAt,
  impact: newsItems.aiImpact,
  summary: newsItems.aiSummary,
  rules: newsItems.aiRules,
  standing: newsItems.aiStanding,
  confidence: newsItems.aiConfidence,
  knownAt: newsItems.aiKnownAt,
  model: newsItems.aiModel,
  costUsd: newsItems.aiCostUsd,
};

type RawItem = Omit<NewsItemRow, 'impact' | 'costUsd'> & { impact: string | null; costUsd: string | null };

function toItem(r: RawItem): NewsItemRow {
  return { ...r, impact: r.impact as NewsImpact | null, costUsd: num(r.costUsd) };
}

/** Stories on the given names published in [from, to), newest first. Market-wide stories are not names and are left out. */
export async function listNewsItems(
  db: DbOrTx,
  opts: { from: Date; to: Date; instrumentIds: number[]; limit?: number },
): Promise<NewsItemRow[]> {
  if (opts.instrumentIds.length === 0) return [];
  const rows = await db
    .select(itemColumns)
    .from(newsItems)
    .leftJoin(instruments, eq(instruments.id, newsItems.instrumentId))
    .where(
      and(
        inArray(newsItems.instrumentId, opts.instrumentIds),
        gte(newsItems.publishedAt, opts.from),
        lt(newsItems.publishedAt, opts.to),
      ),
    )
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(opts.limit ?? 2000);
  return rows.map(toItem);
}

// The zone is a literal, not a bound parameter: select and group by must be the same expression to Postgres.
const dayExpr = sql<string>`(${newsItems.publishedAt} at time zone '${sql.raw(NEWS_TZ)}')::date::text`;

/** Per Hong Kong day, which impact words the stories of these names carry ('none' = not classified). */
export async function newsImpactsByDay(
  db: DbOrTx,
  opts: { from: Date; to: Date; instrumentIds: number[]; hideNeutral?: boolean },
): Promise<Map<ISODate, Set<NewsImpact | 'none'>>> {
  const out = new Map<ISODate, Set<NewsImpact | 'none'>>();
  if (opts.instrumentIds.length === 0) return out;
  const rows = await db
    .select({ day: dayExpr, impact: newsItems.aiImpact })
    .from(newsItems)
    .where(
      and(
        inArray(newsItems.instrumentId, opts.instrumentIds),
        gte(newsItems.publishedAt, opts.from),
        lt(newsItems.publishedAt, opts.to),
        opts.hideNeutral ? or(isNull(newsItems.aiImpact), sql`${newsItems.aiImpact} <> 'neutral'`) : undefined,
      ),
    )
    .groupBy(dayExpr, newsItems.aiImpact);
  for (const r of rows) {
    const set = out.get(r.day) ?? new Set();
    set.add((r.impact as NewsImpact | null) ?? 'none');
    out.set(r.day, set);
  }
  return out;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** Headline, symbol, name and source matches across all days, newest first. */
export async function searchNewsItems(
  db: DbOrTx,
  opts: { q: string; instrumentIds: number[]; limit?: number },
): Promise<NewsItemRow[]> {
  const q = opts.q.trim();
  if (q === '' || opts.instrumentIds.length === 0) return [];
  const pat = `%${likeEscape(q)}%`;
  const rows = await db
    .select(itemColumns)
    .from(newsItems)
    .leftJoin(instruments, eq(instruments.id, newsItems.instrumentId))
    .where(
      and(
        inArray(newsItems.instrumentId, opts.instrumentIds),
        or(
          sql`${newsItems.title} ilike ${pat}`,
          sql`${newsItems.source} ilike ${pat}`,
          sql`${instruments.symbol} ilike ${pat}`,
          sql`${instruments.name} ilike ${pat}`,
        ),
      ),
    )
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(opts.limit ?? 300);
  return rows.map(toItem);
}

/** The Hong Kong day of the oldest story, so the calendar knows how far back it can go. */
export async function earliestNewsDay(db: DbOrTx): Promise<ISODate | null> {
  const [r] = await db.select({ d: sql<string | null>`min(${dayExpr})` }).from(newsItems);
  return r?.d ?? null;
}

export async function lastNewsFetchAt(db: DbOrTx): Promise<Date | null> {
  const [r] = await db.select({ t: sql<Date | null>`max(${newsItems.fetchedAt})` }).from(newsItems);
  return r?.t ? new Date(r.t) : null;
}

// --------------------------------------------------------------------------------------------------- classification
export interface ClassifyCandidate {
  id: number;
  instrumentId: number;
  title: string;
  snippet: string | null;
  source: string;
  url: string;
  publishedAt: Date;
}

/**
 * Stories on names that nothing has judged yet (no impact and no failed attempt), the given names first, then newest first.
 * A rejected or failed-validation attempt keeps `ai_known_at` and so is not offered again.
 */
export async function listUnclassified(
  db: DbOrTx,
  opts: { priorityIds: number[]; since: Date; limit: number },
): Promise<ClassifyCandidate[]> {
  const priority =
    opts.priorityIds.length > 0
      ? sql<number>`case when ${inArray(newsItems.instrumentId, opts.priorityIds)} then 0 else 1 end`
      : sql<number>`1`;
  const rows = await db
    .select({
      id: newsItems.id,
      instrumentId: newsItems.instrumentId,
      title: newsItems.title,
      snippet: newsItems.snippet,
      source: newsItems.source,
      url: newsItems.url,
      publishedAt: newsItems.publishedAt,
    })
    .from(newsItems)
    .where(
      and(
        isNotNull(newsItems.instrumentId),
        isNull(newsItems.aiImpact),
        isNull(newsItems.aiKnownAt),
        gte(newsItems.publishedAt, opts.since),
      ),
    )
    .orderBy(asc(priority), desc(newsItems.publishedAt))
    .limit(opts.limit);
  return rows.map((r) => ({ ...r, instrumentId: r.instrumentId as number }));
}

export interface ClassificationWrite {
  impact: NewsImpact;
  summary: string;
  rules: NewsRule[];
  standing: NewsStanding;
  confidence: number;
  knownAt: Date;
  model: string | null;
  costUsd: number | null;
}

export async function setClassification(db: DbOrTx, id: number, c: ClassificationWrite): Promise<void> {
  await db
    .update(newsItems)
    .set({
      aiImpact: c.impact,
      aiSummary: c.summary,
      aiRules: c.rules,
      aiStanding: c.standing,
      aiConfidence: c.confidence,
      aiKnownAt: c.knownAt,
      aiModel: c.model,
      aiCostUsd: c.costUsd === null ? null : c.costUsd.toFixed(4),
    })
    .where(eq(newsItems.id, id));
}

/** A call that was paid for but whose answer failed validation: the story stays unclassified and is not retried. */
export async function markRejected(
  db: DbOrTx,
  id: number,
  r: { knownAt: Date; model: string | null; costUsd: number | null },
): Promise<void> {
  await db
    .update(newsItems)
    .set({
      aiKnownAt: r.knownAt,
      aiModel: r.model,
      aiCostUsd: r.costUsd === null ? null : r.costUsd.toFixed(4),
    })
    .where(eq(newsItems.id, id));
}

/** What the model calls cost since `since` (stories and briefs), for the daily budget. */
export async function aiSpendSince(db: DbOrTx, since: Date): Promise<number> {
  const [a] = await db
    .select({ s: sql<string | null>`sum(${newsItems.aiCostUsd})` })
    .from(newsItems)
    .where(gte(newsItems.aiKnownAt, since));
  const [b] = await db
    .select({ s: sql<string | null>`sum(${newsBriefs.costUsd})` })
    .from(newsBriefs)
    .where(gte(newsBriefs.asOf, since));
  return (num(a?.s) ?? 0) + (num(b?.s) ?? 0);
}

export async function countUnclassified(db: DbOrTx, since: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(newsItems)
    .where(
      and(
        isNotNull(newsItems.instrumentId),
        isNull(newsItems.aiImpact),
        isNull(newsItems.aiKnownAt),
        gte(newsItems.publishedAt, since),
      ),
    );
  return r?.n ?? 0;
}

// ------------------------------------------------------------------------------------------------------------ briefs
export interface BriefRow {
  id: number;
  day: ISODate;
  asOf: Date;
  session: NewsSession;
  lead: string;
  bullets: NewsBullet[];
  forPuts: string;
  tape: NewsTapeItem[];
  citations: NewsCitation[];
  model: string | null;
  costUsd: number | null;
}

type BriefRaw = typeof newsBriefs.$inferSelect;
const toBrief = (r: BriefRaw): BriefRow => ({ ...r, session: r.session as NewsSession, costUsd: num(r.costUsd) });

/** A scheduled session replaces the brief already stored for that day and session; a manual one is always added. */
export async function saveBrief(db: DbOrTx, b: Omit<BriefRow, 'id'>): Promise<void> {
  const values = {
    day: b.day,
    asOf: b.asOf,
    session: b.session,
    lead: b.lead,
    bullets: b.bullets,
    forPuts: b.forPuts,
    tape: b.tape,
    citations: b.citations,
    model: b.model,
    costUsd: b.costUsd === null ? null : b.costUsd.toFixed(4),
  };
  if (b.session === 'manual') {
    await db.insert(newsBriefs).values(values);
    return;
  }
  await db
    .insert(newsBriefs)
    .values(values)
    .onConflictDoUpdate({
      target: [newsBriefs.day, newsBriefs.session],
      targetWhere: sql`${newsBriefs.session} <> 'manual'`,
      set: { ...values },
    });
}

/** Every brief written for a Hong Kong day, oldest first. */
export async function listBriefsForDay(db: DbOrTx, day: ISODate): Promise<BriefRow[]> {
  const rows = await db.select().from(newsBriefs).where(eq(newsBriefs.day, day)).orderBy(asc(newsBriefs.asOf));
  return rows.map(toBrief);
}

export async function briefDaysBetween(db: DbOrTx, from: ISODate, to: ISODate): Promise<Set<ISODate>> {
  const rows = await db
    .select({ day: newsBriefs.day })
    .from(newsBriefs)
    .where(and(gte(newsBriefs.day, from), sql`${newsBriefs.day} <= ${to}`))
    .groupBy(newsBriefs.day);
  return new Set(rows.map((r) => r.day));
}

export async function earliestBriefDay(db: DbOrTx): Promise<ISODate | null> {
  const [r] = await db.select({ d: sql<string | null>`min(${newsBriefs.day})::text` }).from(newsBriefs);
  return r?.d ?? null;
}

/** Market-wide stories published in [from, to), newest first: the brief's raw material. */
export async function listMarketItems(
  db: DbOrTx,
  opts: { from: Date; to: Date; limit: number },
): Promise<{ url: string; source: string; title: string; snippet: string | null; publishedAt: Date }[]> {
  return db
    .select({
      url: newsItems.url,
      source: newsItems.source,
      title: newsItems.title,
      snippet: newsItems.snippet,
      publishedAt: newsItems.publishedAt,
    })
    .from(newsItems)
    .where(
      and(isNull(newsItems.instrumentId), gte(newsItems.publishedAt, opts.from), lt(newsItems.publishedAt, opts.to)),
    )
    .orderBy(desc(newsItems.publishedAt))
    .limit(opts.limit);
}

// ------------------------------------------------------------------------------------------------- standing inputs
export interface RunRecommendation {
  instrumentId: number;
  strike: number;
  expiry: ISODate;
  dte: number;
  annualizedRoc: number;
  underlyingPrice: number;
}

/** The two most recent stored scan runs (newest first) and each run's recommendations. */
export async function latestScanRecommendations(
  db: DbOrTx,
  runs = 2,
): Promise<{ runId: string; asOf: ISODate; recs: RunRecommendation[] }[]> {
  const rows = await db
    .select({ id: scanRuns.id, asOf: scanRuns.asOf })
    .from(scanRuns)
    .where(and(eq(scanRuns.mode, 'live'), eq(scanRuns.status, 'done')))
    .orderBy(desc(scanRuns.asOf), desc(scanRuns.startedAt))
    .limit(runs);
  const out: { runId: string; asOf: ISODate; recs: RunRecommendation[] }[] = [];
  for (const r of rows) {
    const recs = await db
      .select({
        instrumentId: recommendations.instrumentId,
        strike: recommendations.strike,
        expiry: recommendations.expiry,
        dte: recommendations.dte,
        annualizedRoc: recommendations.annualizedRoc,
        underlyingPrice: recommendations.underlyingPrice,
      })
      .from(recommendations)
      .where(eq(recommendations.scanRunId, r.id))
      .orderBy(asc(recommendations.rank));
    out.push({
      runId: r.id,
      asOf: r.asOf,
      recs: recs.map((x) => ({
        instrumentId: x.instrumentId,
        strike: Number(x.strike),
        expiry: x.expiry,
        dte: x.dte,
        annualizedRoc: Number(x.annualizedRoc),
        underlyingPrice: Number(x.underlyingPrice),
      })),
    });
  }
  return out;
}

export interface OpenPutRow {
  instrumentId: number;
  strike: number;
  expiry: ISODate;
  quantity: number;
}

export async function listOpenPuts(db: DbOrTx): Promise<OpenPutRow[]> {
  const rows = await db
    .select({
      instrumentId: positions.instrumentId,
      strike: positions.strike,
      expiry: positions.expiry,
      quantity: positions.quantity,
    })
    .from(positions)
    .where(eq(positions.status, 'open'))
    .orderBy(asc(positions.expiry));
  return rows.map((r) => ({ ...r, strike: Number(r.strike) }));
}

/** The latest two closes per instrument: spot, and the day's change in percent. */
export async function latestCloses(
  db: DbOrTx,
  ids: number[],
): Promise<Map<number, { close: number; changePct: number | null; day: ISODate }>> {
  const out = new Map<number, { close: number; changePct: number | null; day: ISODate }>();
  if (ids.length === 0) return out;
  const rows = await db.execute(sql`
    select instrument_id, day::text as day, close
    from (
      select instrument_id, day, close,
             row_number() over (partition by instrument_id order by day desc) as rn
      from ${priceBars}
      where instrument_id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
    ) t
    where rn <= 2
    order by instrument_id, day desc`);
  const byId = new Map<number, { day: string; close: number }[]>();
  for (const r of rows.rows as { instrument_id: number | string; day: string; close: string }[]) {
    const id = Number(r.instrument_id);
    const list = byId.get(id) ?? [];
    list.push({ day: r.day, close: Number(r.close) });
    byId.set(id, list);
  }
  for (const [id, list] of byId) {
    const [last, prev] = list;
    if (!last) continue;
    out.set(id, {
      close: last.close,
      day: last.day,
      changePct: prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null,
    });
  }
  return out;
}

/** The latest stored verdict and score of one skill per instrument. */
export async function latestSkillVerdicts(
  db: DbOrTx,
  ids: number[],
  skillId: string,
): Promise<Map<number, { verdict: string; score: number | null; asOf: ISODate }>> {
  const out = new Map<number, { verdict: string; score: number | null; asOf: ISODate }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      instrumentId: skillRuns.instrumentId,
      verdict: skillRuns.verdict,
      score: skillRuns.score,
      asOf: skillRuns.asOf,
    })
    .from(skillRuns)
    .where(and(inArray(skillRuns.instrumentId, ids), eq(skillRuns.skillId, skillId)))
    .orderBy(desc(skillRuns.asOf), desc(skillRuns.id));
  for (const r of rows)
    if (!out.has(r.instrumentId)) out.set(r.instrumentId, { verdict: r.verdict, score: num(r.score), asOf: r.asOf });
  return out;
}

/** The next dated event (earnings first) on or after `from`, per instrument. */
export async function nextEvents(
  db: DbOrTx,
  ids: number[],
  from: ISODate,
): Promise<Map<number, { type: string; date: ISODate; confirmed: boolean }>> {
  const out = new Map<number, { type: string; date: ISODate; confirmed: boolean }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      instrumentId: corporateEvents.instrumentId,
      type: corporateEvents.eventType,
      date: corporateEvents.eventDate,
      confirmed: corporateEvents.confirmed,
    })
    .from(corporateEvents)
    .where(and(inArray(corporateEvents.instrumentId, ids), gte(corporateEvents.eventDate, from)))
    .orderBy(asc(corporateEvents.eventDate));
  for (const r of rows) {
    const cur = out.get(r.instrumentId);
    if (!cur || (r.type === 'earnings' && cur.type !== 'earnings')) out.set(r.instrumentId, r);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- brief inputs
export interface RegimeRow {
  market: Market;
  day: ISODate;
  regime: string;
  volIndex: number | null;
  indexClose: number | null;
  indexSma200: number | null;
  deployCapPct: number;
  deltaCap: number;
}

/** The latest stored market-regime row of each market. */
export async function latestRegimes(db: DbOrTx): Promise<RegimeRow[]> {
  const rows = await db.select().from(marketRegime).orderBy(desc(marketRegime.day)).limit(40);
  const seen = new Set<string>();
  const out: RegimeRow[] = [];
  for (const r of rows) {
    if (seen.has(r.market)) continue;
    seen.add(r.market);
    out.push({
      market: r.market,
      day: r.day,
      regime: r.regime,
      volIndex: num(r.volIndex),
      indexClose: num(r.indexClose),
      indexSma200: num(r.indexSma200),
      deployCapPct: Number(r.deployCapPct),
      deltaCap: Number(r.deltaCap),
    });
  }
  return out;
}

/** The last two stored rates of each pair, newest first. */
export async function latestFxRates(
  db: DbOrTx,
  pairs: string[],
): Promise<Map<string, { day: ISODate; rate: number; previous: number | null }>> {
  const out = new Map<string, { day: ISODate; rate: number; previous: number | null }>();
  for (const pair of pairs) {
    const rows = await db
      .select({ day: fxRates.day, rate: fxRates.rate })
      .from(fxRates)
      .where(eq(fxRates.pair, pair))
      .orderBy(desc(fxRates.day))
      .limit(2);
    const [last, prev] = rows;
    if (last) out.set(pair, { day: last.day, rate: Number(last.rate), previous: prev ? Number(prev.rate) : null });
  }
  return out;
}

/** Dated events of watched names between two days, earliest first (earnings first on a tie). */
export async function upcomingEvents(
  db: DbOrTx,
  opts: { from: ISODate; to: ISODate; instrumentIds: number[] },
): Promise<{ instrumentId: number; type: string; date: ISODate; confirmed: boolean }[]> {
  if (opts.instrumentIds.length === 0) return [];
  const rows = await db
    .select({
      instrumentId: corporateEvents.instrumentId,
      type: corporateEvents.eventType,
      date: corporateEvents.eventDate,
      confirmed: corporateEvents.confirmed,
    })
    .from(corporateEvents)
    .where(
      and(
        inArray(corporateEvents.instrumentId, opts.instrumentIds),
        gte(corporateEvents.eventDate, opts.from),
        sql`${corporateEvents.eventDate} <= ${opts.to}`,
        sql`${corporateEvents.eventType} in ('earnings','ex_dividend')`,
      ),
    )
    .orderBy(asc(corporateEvents.eventDate));
  return rows;
}

export async function briefExists(db: DbOrTx, day: ISODate, session: NewsSession): Promise<boolean> {
  const [r] = await db
    .select({ id: newsBriefs.id })
    .from(newsBriefs)
    .where(and(eq(newsBriefs.day, day), eq(newsBriefs.session, session)))
    .limit(1);
  return r !== undefined;
}

export async function lastBriefAt(db: DbOrTx): Promise<Date | null> {
  const [r] = await db.select({ t: sql<Date | null>`max(${newsBriefs.asOf})` }).from(newsBriefs);
  return r?.t ? new Date(r.t) : null;
}
