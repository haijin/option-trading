/**
 * Reads and writes for the Leaders page (docs/designs/leaders-pullback.md). Display-only tables: no skill, scanner, backtest
 * or DataAccess reads them, and nothing here writes to recommendations, positions, research verdicts or corporate events.
 * The scan reads `price_bars` and the watchlist/universe membership through this module.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { LeaderOutcome, LeaderState, LeadersPayload } from '../core/leaders';
import type { CorporateEvent, DailyBar, Instrument } from '../core/types';
import { num } from '../core/util';
import type { DbOrTx } from './client';
import { toInstrument } from './repos';
import {
  corporateEvents,
  fundamentalStatements,
  instruments,
  leadersCandidates,
  leadersMutes,
  leadersRuns,
  optionContracts,
  priceBars,
  researchRuns,
  watchlist,
} from './schema';

// ----------------------------------------------------------------------------------------------- the screen set
export interface ScreenInstrument {
  instrument: Instrument;
  onWatchlist: boolean;
}

/** Every active universe member of the market plus every active watchlist name (index instruments excluded). */
export async function listScreenInstruments(db: DbOrTx, market: Market): Promise<ScreenInstrument[]> {
  const onWatch = sql<boolean>`exists (select 1 from watchlist w where w.instrument_id = ${instruments.id} and w.active)`;
  const rows = await db
    .select({ i: instruments, w: onWatch })
    .from(instruments)
    .where(
      and(
        eq(instruments.market, market),
        sql`${instruments.sector} is distinct from 'INDEX'`,
        or(
          sql`exists (select 1 from universe_members u where u.instrument_id = ${instruments.id} and u.removed_at is null)`,
          onWatch,
        ),
      ),
    )
    .orderBy(asc(instruments.symbol));
  return rows.map(({ i, w }) => ({ instrument: toInstrument(i), onWatchlist: w === true }));
}

/** Bars with day >= from for many instruments in a few queries, ascending per instrument. */
export async function loadBarsMany(db: DbOrTx, ids: number[], from: ISODate): Promise<Map<number, DailyBar[]>> {
  const out = new Map<number, DailyBar[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = await db
      .select()
      .from(priceBars)
      .where(and(inArray(priceBars.instrumentId, chunk), gte(priceBars.day, from)))
      .orderBy(asc(priceBars.instrumentId), asc(priceBars.day));
    for (const r of rows) {
      const list = out.get(r.instrumentId) ?? [];
      list.push({
        day: r.day,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        adjClose: Number(r.adjClose),
        volume: r.volume,
        source: r.source,
      });
      out.set(r.instrumentId, list);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------- mutes
export interface MuteRow {
  instrumentId: number;
  until: ISODate;
  reason: string;
  createdAt: Date;
}

/** Mutes still in force on `day` (until >= day). */
export async function activeMutes(db: DbOrTx, day: ISODate): Promise<Map<number, MuteRow>> {
  const rows = await db.select().from(leadersMutes).where(gte(leadersMutes.until, day));
  return new Map(rows.map((r) => [r.instrumentId, r]));
}

export async function setMute(db: DbOrTx, instrumentId: number, until: ISODate, reason: string): Promise<void> {
  await db
    .insert(leadersMutes)
    .values({ instrumentId, until, reason })
    .onConflictDoUpdate({ target: leadersMutes.instrumentId, set: { until, reason, createdAt: sql`now()` } });
}

export async function clearMute(db: DbOrTx, instrumentId: number): Promise<boolean> {
  const res = await db.delete(leadersMutes).where(eq(leadersMutes.instrumentId, instrumentId)).returning();
  return res.length > 0;
}

export async function getMute(db: DbOrTx, instrumentId: number): Promise<MuteRow | null> {
  const [r] = await db.select().from(leadersMutes).where(eq(leadersMutes.instrumentId, instrumentId));
  return r ?? null;
}

// ------------------------------------------------------------------------------------------------------- runs
/**
 * Keeps only the newest finished run of each (market, as_of): scanning the same day twice (a manual refresh after the schedule)
 * must not count a name twice in the record or the calendar. `runs` is the alias of leaders_runs in the surrounding query.
 */
const isLatestRunOfDay = sql`${leadersRuns.id} = (select r2.id from leaders_runs r2 where r2.market = ${leadersRuns.market} and r2.as_of = ${leadersRuns.asOf} and r2.status in ('ok', 'partial') order by r2.started_at desc, r2.id desc limit 1)`;

export type RunRow = typeof leadersRuns.$inferSelect;

export interface NewRun {
  market: Market;
  asOf: ISODate;
  startedAt: Date;
  paramsHash: string;
  skillVersion: string;
}

export async function insertRun(db: DbOrTx, r: NewRun): Promise<number> {
  const [row] = await db
    .insert(leadersRuns)
    .values({ ...r, status: 'running' })
    .returning({ id: leadersRuns.id });
  return (row as { id: number }).id;
}

export interface RunFinish {
  status: 'ok' | 'partial' | 'failed';
  finishedAt: Date;
  screened: number;
  leaders: number;
  consolidating: number;
  shortlisted: number;
  regime: string | null;
  posture: 'entries' | 'watch_only';
  detail: Record<string, unknown>;
}

export async function finishRun(db: DbOrTx, id: number, f: RunFinish): Promise<void> {
  await db.update(leadersRuns).set(f).where(eq(leadersRuns.id, id));
}

export async function failRun(db: DbOrTx, id: number, finishedAt: Date, error: string): Promise<void> {
  await db.update(leadersRuns).set({ status: 'failed', finishedAt, detail: { error } }).where(eq(leadersRuns.id, id));
}

/** The newest finished run of a market with as_of <= `asOf` (null asOf = the newest of all). */
export async function latestRun(db: DbOrTx, market: Market, asOf: ISODate | null): Promise<RunRow | null> {
  const [r] = await db
    .select()
    .from(leadersRuns)
    .where(
      and(
        eq(leadersRuns.market, market),
        inArray(leadersRuns.status, ['ok', 'partial']),
        asOf === null ? undefined : lte(leadersRuns.asOf, asOf),
      ),
    )
    .orderBy(desc(leadersRuns.asOf), desc(leadersRuns.startedAt))
    .limit(1);
  return r ?? null;
}

/** The newest finished run of the market whose as_of is strictly before `asOf`. */
export async function previousRun(db: DbOrTx, market: Market, asOf: ISODate): Promise<RunRow | null> {
  const [r] = await db
    .select()
    .from(leadersRuns)
    .where(
      and(eq(leadersRuns.market, market), inArray(leadersRuns.status, ['ok', 'partial']), lt(leadersRuns.asOf, asOf)),
    )
    .orderBy(desc(leadersRuns.asOf), desc(leadersRuns.startedAt))
    .limit(1);
  return r ?? null;
}

export async function getRun(db: DbOrTx, id: number): Promise<RunRow | null> {
  const [r] = await db.select().from(leadersRuns).where(eq(leadersRuns.id, id));
  return r ?? null;
}

/** Dates that have a finished run of either market, ascending. */
export async function runDays(db: DbOrTx): Promise<ISODate[]> {
  const rows = await db
    .select({ day: leadersRuns.asOf })
    .from(leadersRuns)
    .where(inArray(leadersRuns.status, ['ok', 'partial']))
    .groupBy(leadersRuns.asOf)
    .orderBy(asc(leadersRuns.asOf));
  return rows.map((r) => r.day);
}

export async function runInFlight(db: DbOrTx, since: Date): Promise<boolean> {
  const rows = await db
    .select({ id: leadersRuns.id })
    .from(leadersRuns)
    .where(and(eq(leadersRuns.status, 'running'), gte(leadersRuns.startedAt, since)))
    .limit(1);
  return rows.length > 0;
}

export async function setRunBrief(
  db: DbOrTx,
  id: number,
  b: { lead: string | null; model: string | null; costUsd: number },
): Promise<void> {
  await db
    .update(leadersRuns)
    .set({ briefLead: b.lead, briefModel: b.model, briefCostUsd: b.costUsd.toFixed(4) })
    .where(eq(leadersRuns.id, id));
}

/** Sum of brief costs of runs started since `since` (the daily budget). */
export async function briefSpendSince(db: DbOrTx, since: Date): Promise<number> {
  const [r] = await db
    .select({ s: sql<string | null>`sum(${leadersRuns.briefCostUsd})` })
    .from(leadersRuns)
    .where(gte(leadersRuns.startedAt, since));
  return num(r?.s) ?? 0;
}

// ------------------------------------------------------------------------------------------------ candidates
export interface NewCandidate {
  instrumentId: number;
  rank: number | null;
  state: LeaderState;
  score: number;
  payload: LeadersPayload;
}

export async function insertCandidates(db: DbOrTx, runId: number, rows: NewCandidate[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map((r) => ({
      runId,
      instrumentId: r.instrumentId,
      rank: r.rank,
      state: r.state,
      score: r.score.toFixed(2),
      payload: r.payload,
    }));
    if (chunk.length > 0) await db.insert(leadersCandidates).values(chunk).onConflictDoNothing();
  }
}

export interface CandidateRow {
  id: number;
  runId: number;
  instrumentId: number;
  rank: number | null;
  state: LeaderState;
  score: number;
  payload: LeadersPayload;
  briefLine: string | null;
  fwd5: number | null;
  fwd10: number | null;
  fwd20: number | null;
  hit3r: boolean | null;
  stopped: boolean | null;
  maxR: number | null;
  daysTo3r: number | null;
  outcomeAsOf: ISODate | null;
  market: Market;
  symbol: string;
  name: string | null;
  currency: string;
  asOf: ISODate;
  instrument: Instrument;
}

const candidateColumns = {
  c: leadersCandidates,
  i: instruments,
  asOf: leadersRuns.asOf,
};

type JoinedCandidate = {
  c: typeof leadersCandidates.$inferSelect;
  i: typeof instruments.$inferSelect;
  asOf: ISODate;
};

function toCandidate(r: JoinedCandidate): CandidateRow {
  return {
    id: r.c.id,
    runId: r.c.runId,
    instrumentId: r.c.instrumentId,
    rank: r.c.rank,
    state: r.c.state as LeaderState,
    score: Number(r.c.score),
    payload: r.c.payload,
    briefLine: r.c.briefLine,
    fwd5: num(r.c.fwd5),
    fwd10: num(r.c.fwd10),
    fwd20: num(r.c.fwd20),
    hit3r: r.c.hit3r,
    stopped: r.c.stopped,
    maxR: num(r.c.maxR),
    daysTo3r: r.c.daysTo3r,
    outcomeAsOf: r.c.outcomeAsOf,
    market: r.i.market,
    symbol: r.i.symbol,
    name: r.i.name,
    currency: r.i.currency,
    asOf: r.asOf,
    instrument: toInstrument(r.i),
  };
}

export async function listCandidates(db: DbOrTx, runIds: number[]): Promise<CandidateRow[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select(candidateColumns)
    .from(leadersCandidates)
    .innerJoin(instruments, eq(instruments.id, leadersCandidates.instrumentId))
    .innerJoin(leadersRuns, eq(leadersRuns.id, leadersCandidates.runId))
    .where(inArray(leadersCandidates.runId, runIds))
    .orderBy(asc(leadersCandidates.rank), desc(leadersCandidates.score), asc(instruments.symbol));
  return rows.map(toCandidate);
}

export async function getCandidate(db: DbOrTx, id: number): Promise<CandidateRow | null> {
  const [r] = await db
    .select(candidateColumns)
    .from(leadersCandidates)
    .innerJoin(instruments, eq(instruments.id, leadersCandidates.instrumentId))
    .innerJoin(leadersRuns, eq(leadersRuns.id, leadersCandidates.runId))
    .where(eq(leadersCandidates.id, id));
  return r ? toCandidate(r) : null;
}

/** Instrument ids that were on the list (rank not null) of a run. */
export async function listedInstrumentIds(db: DbOrTx, runId: number): Promise<number[]> {
  const rows = await db
    .select({ id: leadersCandidates.instrumentId })
    .from(leadersCandidates)
    .where(and(eq(leadersCandidates.runId, runId), isNotNull(leadersCandidates.rank)));
  return rows.map((r) => r.id);
}

/** Instruments that were on the list in any finished run of the market with as_of in (after, upTo]: for the NEW badge. */
export async function listedBetween(
  db: DbOrTx,
  market: Market,
  after: ISODate,
  upTo: ISODate,
): Promise<Map<number, ISODate>> {
  const rows = await db
    .select({ id: leadersCandidates.instrumentId, asOf: leadersRuns.asOf })
    .from(leadersCandidates)
    .innerJoin(leadersRuns, eq(leadersRuns.id, leadersCandidates.runId))
    .where(
      and(
        eq(leadersRuns.market, market),
        inArray(leadersRuns.status, ['ok', 'partial']),
        isNotNull(leadersCandidates.rank),
        sql`${leadersRuns.asOf} > ${after}`,
        lte(leadersRuns.asOf, upTo),
      ),
    );
  const out = new Map<number, ISODate>();
  for (const r of rows) if (!out.has(r.id) || (out.get(r.id) as string) < r.asOf) out.set(r.id, r.asOf);
  return out;
}

export async function setBriefLines(db: DbOrTx, lines: Map<number, string>): Promise<void> {
  for (const [id, text] of lines)
    await db.update(leadersCandidates).set({ briefLine: text }).where(eq(leadersCandidates.id, id));
}

// ------------------------------------------------------------------------------------------------- outcomes
export interface AwaitingOutcome {
  id: number;
  instrumentId: number;
  asOf: ISODate;
  entry: number;
  stop: number;
}

/** Setup rows whose outcome is not final: no bar counted yet, or still inside the 20-bar window without a 3R / stop. */
export async function candidatesAwaitingOutcome(db: DbOrTx, market: Market): Promise<AwaitingOutcome[]> {
  const rows = await db
    .select({
      id: leadersCandidates.id,
      instrumentId: leadersCandidates.instrumentId,
      asOf: leadersRuns.asOf,
      payload: leadersCandidates.payload,
    })
    .from(leadersCandidates)
    .innerJoin(leadersRuns, eq(leadersRuns.id, leadersCandidates.runId))
    .where(
      and(
        eq(leadersRuns.market, market),
        isLatestRunOfDay,
        eq(leadersCandidates.state, 'setup'),
        sql`(${leadersCandidates.hit3r} is null or (${leadersCandidates.hit3r} = false and ${leadersCandidates.stopped} = false and ${leadersCandidates.fwd20} is null))`,
      ),
    );
  const out: AwaitingOutcome[] = [];
  for (const r of rows) {
    const plan = r.payload.plan;
    if (plan) out.push({ id: r.id, instrumentId: r.instrumentId, asOf: r.asOf, entry: plan.entry, stop: plan.stop });
  }
  return out;
}

export async function writeOutcome(db: DbOrTx, id: number, o: LeaderOutcome): Promise<void> {
  const f = (x: number | null): string | null => (x === null ? null : x.toFixed(5));
  await db
    .update(leadersCandidates)
    .set({
      fwd5: f(o.fwd5),
      fwd10: f(o.fwd10),
      fwd20: f(o.fwd20),
      hit3r: o.hit3r,
      stopped: o.stopped,
      maxR: o.maxR.toFixed(3),
      daysTo3r: o.daysTo3r,
      outcomeAsOf: o.outcomeAsOf,
    })
    .where(eq(leadersCandidates.id, id));
}

/** Setup and Watch rows on the list (rank not null) since `from` (null = ever), with the run's date, for the record card. */
export async function listedRowsSince(db: DbOrTx, from: ISODate | null): Promise<CandidateRow[]> {
  const rows = await db
    .select(candidateColumns)
    .from(leadersCandidates)
    .innerJoin(instruments, eq(instruments.id, leadersCandidates.instrumentId))
    .innerJoin(leadersRuns, eq(leadersRuns.id, leadersCandidates.runId))
    .where(
      and(
        isNotNull(leadersCandidates.rank),
        inArray(leadersCandidates.state, ['setup', 'watch']),
        inArray(leadersRuns.status, ['ok', 'partial']),
        isLatestRunOfDay,
        from === null ? undefined : gte(leadersRuns.asOf, from),
      ),
    )
    .orderBy(asc(leadersRuns.asOf));
  return rows.map(toCandidate);
}

// ---------------------------------------------------------------------------------------------- side lookups
/** Which of these instruments have statements / a stored option chain, and how many finished research runs each has. */
export async function instrumentFacts(
  db: DbOrTx,
  ids: number[],
): Promise<{ statements: Set<number>; chains: Set<number>; reports: Map<number, number> }> {
  const out = { statements: new Set<number>(), chains: new Set<number>(), reports: new Map<number, number>() };
  if (ids.length === 0) return out;
  const st = await db
    .select({ id: fundamentalStatements.instrumentId })
    .from(fundamentalStatements)
    .where(inArray(fundamentalStatements.instrumentId, ids))
    .groupBy(fundamentalStatements.instrumentId);
  for (const r of st) out.statements.add(r.id);
  const ch = await db
    .select({ id: optionContracts.instrumentId })
    .from(optionContracts)
    .where(inArray(optionContracts.instrumentId, ids))
    .groupBy(optionContracts.instrumentId);
  for (const r of ch) out.chains.add(r.id);
  const rr = await db
    .select({ id: researchRuns.instrumentId, n: sql<number>`count(*)::int` })
    .from(researchRuns)
    .where(and(inArray(researchRuns.instrumentId, ids), eq(researchRuns.status, 'done')))
    .groupBy(researchRuns.instrumentId);
  for (const r of rr) out.reports.set(r.id, r.n);
  return out;
}

/** Stored earnings and ex-dividend dates on or after `from` for the names the user follows (read only). */
export async function loadUpcomingEvents(
  db: DbOrTx,
  ids: number[],
  from: ISODate,
): Promise<Map<number, CorporateEvent[]>> {
  const out = new Map<number, CorporateEvent[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(corporateEvents)
    .where(
      and(
        inArray(corporateEvents.instrumentId, ids),
        inArray(corporateEvents.eventType, ['earnings', 'ex_dividend']),
        gte(corporateEvents.eventDate, from),
      ),
    );
  for (const e of rows) {
    const list = out.get(e.instrumentId) ?? [];
    list.push({
      type: e.eventType as CorporateEvent['type'],
      date: e.eventDate,
      confirmed: e.confirmed,
      source: e.source,
      knownAt: e.knownAt.toISOString(),
      details: e.details,
    });
    out.set(e.instrumentId, list);
  }
  return out;
}

/** Instrument ids on the active watchlist. */
export async function listWatchlistIds(db: DbOrTx): Promise<Set<number>> {
  const rows = await db.select({ id: watchlist.instrumentId }).from(watchlist).where(eq(watchlist.active, true));
  return new Set(rows.map((r) => r.id));
}

/** Per run day in [from, to): how many Setup and Watch names were on the lists (calendar dots). */
export async function setupCountsByDay(
  db: DbOrTx,
  from: ISODate,
  to: ISODate,
): Promise<{ day: ISODate; setups: number; watch: number }[]> {
  const res = await db.execute(sql`
    select r.as_of::text as day,
           count(*) filter (where c.state = 'setup')::int as setups,
           count(*) filter (where c.state = 'watch')::int as watch
    from leaders_candidates c
    join leaders_runs r on r.id = c.run_id
    where c.rank is not null and r.status in ('ok', 'partial') and r.as_of >= ${from} and r.as_of < ${to}
      and r.id = (select r2.id from leaders_runs r2 where r2.market = r.market and r2.as_of = r.as_of and r2.status in ('ok', 'partial') order by r2.started_at desc, r2.id desc limit 1)
    group by r.as_of
    order by r.as_of`);
  return (res.rows as { day: string; setups: number; watch: number }[]).map((x) => ({
    day: x.day,
    setups: x.setups,
    watch: x.watch,
  }));
}
