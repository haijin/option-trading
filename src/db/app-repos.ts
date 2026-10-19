/**
 * Reads and writes the local web app needs on top of repos.ts: the full watchlist (active and paused), per-stock edits,
 * valuation overrides, imported fair values, research runs, detailed positions and per-stock data status.
 * No provider or CLI code in here (module rule); the server composes these with the existing writers.
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { Instrument, ReportingFrequency, SolvencyModel } from '../core/types';
import { num } from '../core/util';
import type { DbOrTx } from './client';
import { toInstrument } from './repos';
import {
  corporateEvents,
  fairValues,
  fundamentalStatements,
  instruments,
  ivDaily,
  jobRuns,
  positions,
  priceBars,
  recommendations,
  researchRuns,
  scanRuns,
  valuationOverrides,
  watchlist,
} from './schema';

// ------------------------------------------------------------------------------------------------ watchlist
export interface WatchRow extends Instrument {
  watchlistId: number;
  active: boolean;
  conviction: number | null;
  notes: string | null;
  maxCollateralPct: number | null;
  addedAt: Date;
  /** 'user' when the solvency model was chosen by the user; anything else means it may still be inferred at ingest. */
  solvencySource: string | null;
}

type WatchJoin = { i: typeof instruments.$inferSelect; w: typeof watchlist.$inferSelect };

function toWatchRow({ i, w }: WatchJoin): WatchRow {
  const src = i.providerSymbols?.solvencySource;
  return {
    ...toInstrument(i),
    watchlistId: w.id,
    active: w.active,
    conviction: w.conviction,
    notes: w.notes,
    maxCollateralPct: num(w.maxCollateralPct),
    addedAt: w.addedAt,
    solvencySource: typeof src === 'string' ? src : null,
  };
}

/** Every watchlist row, active or paused, ordered market then symbol. */
export async function listWatchlistAll(db: DbOrTx): Promise<WatchRow[]> {
  const rows = await db
    .select({ i: instruments, w: watchlist })
    .from(watchlist)
    .innerJoin(instruments, eq(instruments.id, watchlist.instrumentId))
    .orderBy(asc(instruments.market), asc(instruments.symbol));
  return rows.map(toWatchRow);
}

export async function getWatchRow(db: DbOrTx, market: Market, symbol: string): Promise<WatchRow | null> {
  const [r] = await db
    .select({ i: instruments, w: watchlist })
    .from(watchlist)
    .innerJoin(instruments, eq(instruments.id, watchlist.instrumentId))
    .where(and(eq(instruments.market, market), eq(instruments.symbol, symbol)));
  return r ? toWatchRow(r) : null;
}

export interface WatchRowPatch {
  active?: boolean;
  conviction?: number | null;
  notes?: string | null;
  maxCollateralPct?: number | null;
}

export async function updateWatchRow(db: DbOrTx, instrumentId: number, patch: WatchRowPatch): Promise<void> {
  const set: Partial<typeof watchlist.$inferInsert> = {};
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.conviction !== undefined) set.conviction = patch.conviction;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.maxCollateralPct !== undefined)
    set.maxCollateralPct = patch.maxCollateralPct === null ? null : patch.maxCollateralPct.toFixed(2);
  if (Object.keys(set).length === 0) return;
  await db.update(watchlist).set(set).where(eq(watchlist.instrumentId, instrumentId));
}

export interface InstrumentPatch {
  boardLot?: number;
  solvencyModel?: SolvencyModel;
  reportingFrequency?: ReportingFrequency;
  name?: string | null;
}

/** Edits fields of the instrument itself. Choosing a solvency model records `solvencySource: user` so ingest never overrides it. */
export async function updateInstrument(db: DbOrTx, instrumentId: number, patch: InstrumentPatch): Promise<void> {
  const set: Partial<typeof instruments.$inferInsert> = {};
  if (patch.boardLot !== undefined) set.boardLot = patch.boardLot;
  if (patch.reportingFrequency !== undefined) set.reportingFrequency = patch.reportingFrequency;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.solvencyModel !== undefined) {
    set.solvencyModel = patch.solvencyModel;
    const [cur] = await db
      .select({ p: instruments.providerSymbols })
      .from(instruments)
      .where(eq(instruments.id, instrumentId));
    set.providerSymbols = { ...(cur?.p ?? {}), solvencySource: 'user' };
  }
  if (Object.keys(set).length === 0) return;
  await db.update(instruments).set(set).where(eq(instruments.id, instrumentId));
}

// ------------------------------------------------------------------------------------------------ valuation overrides
export async function getValuationOverrides(db: DbOrTx, instrumentId: number): Promise<Record<string, unknown> | null> {
  const [r] = await db.select().from(valuationOverrides).where(eq(valuationOverrides.instrumentId, instrumentId));
  return r ? r.data : null;
}

/** Stores overrides, or clears them when `data` is null or empty. */
export async function setValuationOverrides(
  db: DbOrTx,
  instrumentId: number,
  data: Record<string, unknown> | null,
): Promise<void> {
  if (data === null || Object.keys(data).length === 0) {
    await db.delete(valuationOverrides).where(eq(valuationOverrides.instrumentId, instrumentId));
    return;
  }
  await db
    .insert(valuationOverrides)
    .values({ instrumentId, data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: valuationOverrides.instrumentId, set: { data, updatedAt: new Date() } });
}

// ------------------------------------------------------------------------------------------------ fair values
export interface FairValueRow {
  value: number;
  asOf: ISODate;
  moat: string | null;
  uncertainty: string | null;
  source: string;
}

export async function upsertFairValue(
  db: DbOrTx,
  v: {
    instrumentId: number;
    asOf: ISODate;
    value: number;
    moat?: string | null;
    uncertainty?: string | null;
    source?: string;
  },
): Promise<void> {
  const source = v.source ?? 'morningstar_csv';
  await db
    .insert(fairValues)
    .values({
      instrumentId: v.instrumentId,
      asOf: v.asOf,
      value: v.value.toFixed(6),
      source,
      moat: v.moat ?? null,
      uncertainty: v.uncertainty ?? null,
    })
    .onConflictDoUpdate({
      target: [fairValues.instrumentId, fairValues.asOf, fairValues.source],
      set: {
        value: v.value.toFixed(6),
        moat: v.moat ?? null,
        uncertainty: v.uncertainty ?? null,
        importedAt: new Date(),
      },
    });
}

export async function latestFairValue(db: DbOrTx, instrumentId: number): Promise<FairValueRow | null> {
  const [r] = await db
    .select()
    .from(fairValues)
    .where(eq(fairValues.instrumentId, instrumentId))
    .orderBy(desc(fairValues.asOf), desc(fairValues.id))
    .limit(1);
  return r
    ? { value: Number(r.value), asOf: r.asOf, moat: r.moat, uncertainty: r.uncertainty, source: r.source }
    : null;
}

// ------------------------------------------------------------------------------------------------ research runs
export type RunStatusDb = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ResearchRunRow {
  id: string;
  instrumentId: number;
  skillId: string;
  status: RunStatusDb;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  stepIndex: number;
  progress: string[];
  costUsd: number | null;
  model: string | null;
  error: string | null;
  reportPath: string | null;
  result: unknown;
}

function toRunRow(r: typeof researchRuns.$inferSelect): ResearchRunRow {
  return {
    id: r.id,
    instrumentId: r.instrumentId,
    skillId: r.skillId,
    status: r.status as RunStatusDb,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    stepIndex: r.stepIndex,
    progress: r.progress,
    costUsd: num(r.costUsd),
    model: r.model,
    error: r.error,
    reportPath: r.reportPath,
    result: r.result,
  };
}

export async function createResearchRun(db: DbOrTx, instrumentId: number, skillId: string): Promise<ResearchRunRow> {
  const [r] = await db.insert(researchRuns).values({ instrumentId, skillId, status: 'queued' }).returning();
  return toRunRow(r as typeof researchRuns.$inferSelect);
}

export interface ResearchRunPatch {
  status?: RunStatusDb;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  stepIndex?: number;
  progress?: string[];
  costUsd?: number | null;
  model?: string | null;
  error?: string | null;
  reportPath?: string | null;
  result?: unknown;
}

export async function updateResearchRun(db: DbOrTx, id: string, patch: ResearchRunPatch): Promise<void> {
  const set: Partial<typeof researchRuns.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (patch.stepIndex !== undefined) set.stepIndex = patch.stepIndex;
  if (patch.progress !== undefined) set.progress = patch.progress;
  if (patch.costUsd !== undefined) set.costUsd = patch.costUsd === null ? null : patch.costUsd.toFixed(4);
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.reportPath !== undefined) set.reportPath = patch.reportPath;
  if (patch.result !== undefined) set.result = patch.result as Record<string, unknown>;
  if (Object.keys(set).length === 0) return;
  await db.update(researchRuns).set(set).where(eq(researchRuns.id, id));
}

export async function getResearchRun(db: DbOrTx, id: string): Promise<ResearchRunRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db.select().from(researchRuns).where(eq(researchRuns.id, id));
  return r ? toRunRow(r) : null;
}

/** Newest first; restricted to one instrument when given. */
export async function listResearchRuns(db: DbOrTx, instrumentId?: number, limit = 100): Promise<ResearchRunRow[]> {
  const q = db.select().from(researchRuns);
  const rows = await (instrumentId === undefined ? q : q.where(eq(researchRuns.instrumentId, instrumentId)))
    .orderBy(desc(researchRuns.createdAt))
    .limit(limit);
  return rows.map(toRunRow);
}

/** Runs left queued or running by a process that died: mark them failed so the UI never polls a ghost. */
export async function failOrphanedRuns(db: DbOrTx, reason: string): Promise<number> {
  const rows = await db
    .update(researchRuns)
    .set({ status: 'failed', error: reason, finishedAt: new Date() })
    .where(inArray(researchRuns.status, ['queued', 'running']))
    .returning({ id: researchRuns.id });
  return rows.length;
}

/** Newest first; one instrument and one skill id (the Ask chat lists its own rows this way). */
export async function listResearchRunsBySkill(
  db: DbOrTx,
  instrumentId: number,
  skillId: string,
  limit = 50,
): Promise<ResearchRunRow[]> {
  const rows = await db
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.instrumentId, instrumentId), eq(researchRuns.skillId, skillId)))
    .orderBy(desc(researchRuns.createdAt))
    .limit(limit);
  return rows.map(toRunRow);
}

/** Runs of one skill created at or after `since` and what they cost so far (a run still writing counts as zero). */
export async function skillSpendSince(
  db: DbOrTx,
  skillId: string,
  since: Date,
): Promise<{ runs: number; costUsd: number }> {
  const [r] = await db
    .select({ runs: sql<number>`count(*)::int`, cost: sql<string | null>`sum(${researchRuns.costUsd})` })
    .from(researchRuns)
    .where(and(eq(researchRuns.skillId, skillId), gte(researchRuns.createdAt, since)));
  return { runs: r?.runs ?? 0, costUsd: Number(r?.cost ?? 0) };
}

// ------------------------------------------------------------------------------------------------ grounding reads (Ask)
export interface IvDailyRow {
  day: ISODate;
  iv30: number | null;
  iv60: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  rv20: number | null;
  rv60: number | null;
  skew25d: number | null;
  termRatio: number | null;
  tier: string;
}

/** The most recent stored IV row of a name, or null. */
export async function latestIvDaily(db: DbOrTx, instrumentId: number): Promise<IvDailyRow | null> {
  const [r] = await db
    .select()
    .from(ivDaily)
    .where(eq(ivDaily.instrumentId, instrumentId))
    .orderBy(desc(ivDaily.day))
    .limit(1);
  if (!r) return null;
  return {
    day: r.day,
    iv30: num(r.iv30),
    iv60: num(r.iv60),
    ivRank: num(r.ivRank),
    ivPercentile: num(r.ivPercentile),
    rv20: num(r.rv20),
    rv60: num(r.rv60),
    skew25d: num(r.skew25d),
    termRatio: num(r.termRatio),
    tier: r.tier,
  };
}

export interface StoredRecommendation {
  asOf: ISODate;
  rank: number;
  strike: number;
  expiry: ISODate;
  dte: number;
  underlyingPrice: number;
  creditPerContract: number;
  collateralPerContract: number;
  annualizedRoc: number;
  breakeven: number;
  cushionPct: number;
  probItm: number | null;
  composite: number;
  suggestedContracts: number | null;
  reasons: unknown[];
}

/** The newest stored recommendation for a name (from any saved live or backtest scan run), or null. */
export async function latestRecommendationFor(db: DbOrTx, instrumentId: number): Promise<StoredRecommendation | null> {
  const [r] = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.instrumentId, instrumentId))
    .orderBy(desc(recommendations.asOf), desc(recommendations.id))
    .limit(1);
  if (!r) return null;
  return {
    asOf: r.asOf,
    rank: r.rank,
    strike: Number(r.strike),
    expiry: r.expiry,
    dte: r.dte,
    underlyingPrice: Number(r.underlyingPrice),
    creditPerContract: Number(r.creditPerContract),
    collateralPerContract: Number(r.collateralPerContract),
    annualizedRoc: Number(r.annualizedRoc),
    breakeven: Number(r.breakeven),
    cushionPct: Number(r.cushionPct),
    probItm: num(r.probItm),
    composite: Number(r.composite),
    suggestedContracts: r.suggestedContracts,
    reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]) : [],
  };
}

// ------------------------------------------------------------------------------------------------ positions
export interface PositionRow {
  id: number;
  instrument: Instrument;
  strike: number;
  expiry: ISODate;
  multiplier: number;
  quantity: number;
  openDate: ISODate;
  openPrice: number;
  openFees: number;
  closeDate: ISODate | null;
  closePrice: number | null;
  status: 'open' | 'closed' | 'rolled' | 'assigned' | 'expired';
  realizedPnl: number | null;
  source: 'manual' | 'journal_import';
}

export async function listPositionsDetailed(db: DbOrTx): Promise<PositionRow[]> {
  const rows = await db
    .select({ p: positions, i: instruments })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .orderBy(desc(positions.openDate), desc(positions.id));
  return rows.map(({ p, i }) => ({
    id: p.id,
    instrument: toInstrument(i),
    strike: Number(p.strike),
    expiry: p.expiry,
    multiplier: p.multiplier,
    quantity: p.quantity,
    openDate: p.openDate,
    openPrice: Number(p.openPrice),
    openFees: Number(p.openFees),
    closeDate: p.closeDate,
    closePrice: p.closePrice === null ? null : Number(p.closePrice),
    status: p.status,
    realizedPnl: p.realizedPnl === null ? null : Number(p.realizedPnl),
    source: p.source as 'manual' | 'journal_import',
  }));
}

export async function getPositionRow(db: DbOrTx, id: number): Promise<PositionRow | null> {
  return (await listPositionsDetailed(db)).find((p) => p.id === id) ?? null;
}

// ------------------------------------------------------------------------------------------------ runs and jobs
export interface LatestScan {
  id: string;
  asOf: ISODate;
  startedAt: Date;
  ideas: number;
}

export async function latestScanRun(db: DbOrTx): Promise<LatestScan | null> {
  const [r] = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.mode, 'live'))
    .orderBy(desc(scanRuns.startedAt))
    .limit(1);
  if (!r) return null;
  const ranked = (r.stats as { ranked?: { US?: number; HK?: number } } | null)?.ranked;
  return { id: r.id, asOf: r.asOf, startedAt: r.startedAt, ideas: (ranked?.US ?? 0) + (ranked?.HK ?? 0) };
}

export interface FinishedJob {
  id: number;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  rowsWritten: number | null;
  error: string | null;
  meta: unknown;
}

export async function lastJob(db: DbOrTx, job: string): Promise<FinishedJob | null> {
  const [r] = await db.select().from(jobRuns).where(eq(jobRuns.job, job)).orderBy(desc(jobRuns.startedAt)).limit(1);
  return r
    ? {
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        rowsWritten: r.rowsWritten,
        error: r.error,
        meta: r.meta,
      }
    : null;
}

// ------------------------------------------------------------------------------------------------ data status
export interface DataStatusRaw {
  lastBar: ISODate | null;
  lastClose: number | null;
  chain: { source: string; date: ISODate } | null;
  annual: number;
  quarterly: number;
  lastPeriodEnd: ISODate | null;
  nextEarnings: { date: ISODate; confirmed: boolean; source: string; knownAt: string } | null;
}

/** One pass of grouped queries for the per-stock data table. `today` bounds "next" earnings dates. */
export async function dataStatusFor(
  db: DbOrTx,
  instrumentIds: number[],
  today: ISODate,
): Promise<Map<number, DataStatusRaw>> {
  const out = new Map<number, DataStatusRaw>();
  for (const id of instrumentIds)
    out.set(id, {
      lastBar: null,
      lastClose: null,
      chain: null,
      annual: 0,
      quarterly: 0,
      lastPeriodEnd: null,
      nextEarnings: null,
    });
  if (instrumentIds.length === 0) return out;
  const ids = sql.join(
    instrumentIds.map((i) => sql`${i}`),
    sql`, `,
  );

  const bars = await db.execute(sql`
    select distinct on (instrument_id) instrument_id, day, close
    from price_bars where instrument_id in (${ids}) order by instrument_id, day desc`);
  for (const r of bars.rows as { instrument_id: string | number; day: string | Date; close: string }[]) {
    const e = out.get(Number(r.instrument_id));
    if (e) {
      e.lastBar = typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10);
      e.lastClose = Number(r.close);
    }
  }

  const stm = await db.execute(sql`
    select instrument_id,
           count(*) filter (where period_type = 'annual')::int as annual,
           count(*) filter (where period_type in ('quarterly','semiannual'))::int as quarterly,
           max(period_end) as last_period
    from fundamental_statements where instrument_id in (${ids}) group by instrument_id`);
  for (const r of stm.rows as {
    instrument_id: string | number;
    annual: number;
    quarterly: number;
    last_period: string | Date | null;
  }[]) {
    const e = out.get(Number(r.instrument_id));
    if (e) {
      e.annual = r.annual;
      e.quarterly = r.quarterly;
      e.lastPeriodEnd =
        r.last_period === null
          ? null
          : typeof r.last_period === 'string'
            ? r.last_period
            : r.last_period.toISOString().slice(0, 10);
    }
  }

  const chains = await db.execute(sql`
    select distinct on (c.instrument_id) c.instrument_id, q.snapshot_date, q.source
    from option_quotes q join option_contracts c on c.id = q.contract_id
    where c.instrument_id in (${ids}) order by c.instrument_id, q.snapshot_date desc`);
  for (const r of chains.rows as { instrument_id: string | number; snapshot_date: string | Date; source: string }[]) {
    const e = out.get(Number(r.instrument_id));
    if (e)
      e.chain = {
        source: r.source.replace(/\+greeks:computed$/, ''),
        date: typeof r.snapshot_date === 'string' ? r.snapshot_date : r.snapshot_date.toISOString().slice(0, 10),
      };
  }

  const ev = await db
    .select()
    .from(corporateEvents)
    .where(and(inArray(corporateEvents.instrumentId, instrumentIds), eq(corporateEvents.eventType, 'earnings')))
    .orderBy(asc(corporateEvents.eventDate));
  for (const r of ev) {
    if (r.eventDate < today) continue;
    const e = out.get(r.instrumentId);
    if (e && !e.nextEarnings)
      e.nextEarnings = {
        date: r.eventDate,
        confirmed: r.confirmed,
        source: r.source,
        knownAt: r.knownAt.toISOString(),
      };
  }
  return out;
}

export async function countBarsFor(db: DbOrTx, instrumentId: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(priceBars)
    .where(eq(priceBars.instrumentId, instrumentId));
  return r?.n ?? 0;
}

/** Latest stored close per instrument, a cheap single-pass read for the Positions page. */
export async function lastCloses(
  db: DbOrTx,
  instrumentIds: number[],
): Promise<Map<number, { day: ISODate; close: number }>> {
  const out = new Map<number, { day: ISODate; close: number }>();
  if (instrumentIds.length === 0) return out;
  const ids = sql.join(
    instrumentIds.map((i) => sql`${i}`),
    sql`, `,
  );
  const r = await db.execute(sql`
    select distinct on (instrument_id) instrument_id, day, close
    from price_bars where instrument_id in (${ids}) order by instrument_id, day desc`);
  for (const x of r.rows as { instrument_id: string | number; day: string | Date; close: string }[])
    out.set(Number(x.instrument_id), {
      day: typeof x.day === 'string' ? x.day : x.day.toISOString().slice(0, 10),
      close: Number(x.close),
    });
  return out;
}

/**
 * The last `count` closes on or before `asOf` per instrument, oldest first, in one grouped read (the watchlist board's
 * price, daily change and sparkline). Point-in-time: a bar after `asOf` is never returned.
 */
export async function recentCloses(
  db: DbOrTx,
  instrumentIds: number[],
  asOf: ISODate,
  count: number,
): Promise<Map<number, { day: ISODate; close: number }[]>> {
  const out = new Map<number, { day: ISODate; close: number }[]>();
  if (instrumentIds.length === 0 || count <= 0) return out;
  const ids = sql.join(
    instrumentIds.map((i) => sql`${i}`),
    sql`, `,
  );
  const r = await db.execute(sql`
    select instrument_id, day, close from (
      select instrument_id, day, close,
             row_number() over (partition by instrument_id order by day desc) as rn
      from price_bars where instrument_id in (${ids}) and day <= ${asOf}
    ) t where rn <= ${count} order by instrument_id, day asc`);
  for (const x of r.rows as { instrument_id: string | number; day: string | Date; close: string }[]) {
    const id = Number(x.instrument_id);
    const list = out.get(id) ?? [];
    list.push({
      day: typeof x.day === 'string' ? x.day : x.day.toISOString().slice(0, 10),
      close: Number(x.close),
    });
    out.set(id, list);
  }
  return out;
}

/** True when at least one statement is stored for the instrument (the quality screen is local and needs them). */
export async function hasStatements(db: DbOrTx, instrumentId: number): Promise<boolean> {
  const rows = await db
    .select({ id: fundamentalStatements.instrumentId })
    .from(fundamentalStatements)
    .where(eq(fundamentalStatements.instrumentId, instrumentId))
    .limit(1);
  return rows.length > 0;
}
