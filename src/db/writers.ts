/**
 * Every function that writes data feeding a skill result lives here and calls `invalidateSkillRuns` /
 * `invalidateAllSkillRuns` with the earliest changed date (docs/02 section 2, task T5).
 *
 * tests/db/writers.test.ts enumerates this module's exports: each `write*` function must be listed in DATA_WRITERS and
 * must delete cached skill_runs; no other file may insert into these tables directly.
 */
import { and, between, eq, gte, sql } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import { addDays, type ISODate, minDate, toISO } from '../core/dates';
import { resolveReportedAt } from '../core/reported-at';
import type {
  DailyBar,
  DataTier,
  EventType,
  FundamentalStatement,
  OptionChainSnapshot,
  PeriodType,
} from '../core/types';
import type { DbOrTx } from './client';
import { invalidateAllSkillRuns, invalidateSkillRuns } from './invalidate';
import {
  corporateEvents,
  fundamentalStatements,
  fxRates,
  ivDaily,
  optionContracts,
  optionQuotes,
  priceBars,
  pricingCalibration,
} from './schema';

export interface WriteResult {
  inserted: number;
  updated: number;
  unchanged: number;
  earliestChanged: ISODate | null;
  /** skill_runs rows deleted by the invalidation this write triggered. */
  invalidated: number;
}

const EMPTY: WriteResult = { inserted: 0, updated: 0, unchanged: 0, earliestChanged: null, invalidated: 0 };

const CHUNK = 400;

/**
 * Knowledge-time data (filings, events) can matter to a LIVE scan whose as-of date is up to a few days older than the
 * moment it was learned (the as-of is the last completed session; ingest may run the next morning, see
 * DataAccess.knownThrough). Invalidation therefore reaches back this many days from the knowledge date.
 */
export const KNOWLEDGE_LOOKBACK_DAYS = 3;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function fix(x: number | null | undefined, scale: number): string | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return x.toFixed(scale);
}

function eqFix(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

/**
 * Yahoo recomputes adjusted closes in float32 on every request, so the 6th decimal wobbles between fetches (relative
 * ~2e-7) even when nothing was restated. A real dividend or split moves history by 1e-4 or more, so differences below
 * this relative tolerance are noise: counting them as restated would invalidate every cached skill result on every
 * ingest.
 */
const ADJ_CLOSE_REL_TOLERANCE = 1e-5;

function eqAdjClose(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = Number(a);
  const y = Number(b);
  return Math.abs(x - y) <= ADJ_CLOSE_REL_TOLERANCE * Math.max(Math.abs(x), Math.abs(y));
}

// ---------------------------------------------------------------- bars
export async function writeBars(db: DbOrTx, instrumentId: number, bars: DailyBar[]): Promise<WriteResult> {
  if (bars.length === 0) return { ...EMPTY };
  const sorted = [...bars].sort((a, b) => a.day.localeCompare(b.day));
  const existing = await db
    .select()
    .from(priceBars)
    .where(
      and(
        eq(priceBars.instrumentId, instrumentId),
        between(priceBars.day, sorted[0]?.day as string, sorted[sorted.length - 1]?.day as string),
      ),
    );
  const byDay = new Map(existing.map((r) => [r.day, r]));
  const toWrite: (typeof priceBars.$inferInsert)[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let earliest: ISODate | null = null;
  for (const b of sorted) {
    const row = {
      instrumentId,
      day: b.day,
      open: fix(b.open, 6) as string,
      high: fix(b.high, 6) as string,
      low: fix(b.low, 6) as string,
      close: fix(b.close, 6) as string,
      adjClose: fix(b.adjClose, 6) as string,
      volume: Math.round(b.volume),
      source: b.source,
    };
    const old = byDay.get(b.day);
    if (
      old &&
      eqFix(old.open, row.open) &&
      eqFix(old.high, row.high) &&
      eqFix(old.low, row.low) &&
      eqFix(old.close, row.close) &&
      eqAdjClose(old.adjClose, row.adjClose) &&
      old.volume === row.volume &&
      old.source === row.source
    ) {
      unchanged++;
      continue;
    }
    if (old) updated++;
    else inserted++;
    earliest = earliest === null ? b.day : minDate(earliest, b.day);
    toWrite.push(row);
  }
  for (const part of chunks(toWrite)) {
    await db
      .insert(priceBars)
      .values(part)
      .onConflictDoUpdate({
        target: [priceBars.instrumentId, priceBars.day],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          adjClose: sql`excluded.adj_close`,
          volume: sql`excluded.volume`,
          source: sql`excluded.source`,
        },
      });
  }
  const invalidated = earliest ? await invalidateSkillRuns(db, instrumentId, earliest) : 0;
  return { inserted, updated, unchanged, earliestChanged: earliest, invalidated };
}

// --------------------------------------------------------- fundamentals
export type StatementInput = Omit<FundamentalStatement, 'reportedAt' | 'reportedAtEstimated' | 'firstSeenAt'> & {
  /** A real filing timestamp when the provider has one; otherwise reported_at is estimated and clamped. */
  reportedAtActual: Date | null;
  raw?: unknown;
};

const STATEMENT_NUMERIC = [
  ['revenue', 2],
  ['grossProfit', 2],
  ['operatingIncome', 2],
  ['ebit', 2],
  ['ebitda', 2],
  ['interestExpense', 2],
  ['netIncome', 2],
  ['epsDiluted', 6],
  ['sharesDiluted', 2],
  ['totalAssets', 2],
  ['currentAssets', 2],
  ['currentLiabilities', 2],
  ['totalLiabilities', 2],
  ['longTermDebt', 2],
  ['totalDebt', 2],
  ['cash', 2],
  ['retainedEarnings', 2],
  ['totalEquity', 2],
  ['cfo', 2],
  ['capex', 2],
  ['fcf', 2],
  ['dividendsPaid', 2],
  ['buybacks', 2],
] as const;

export async function writeFundamentals(
  db: DbOrTx,
  instrumentId: number,
  market: Market,
  statements: StatementInput[],
  now: Date,
): Promise<WriteResult> {
  if (statements.length === 0) return { ...EMPTY };
  const existing = await db
    .select()
    .from(fundamentalStatements)
    .where(eq(fundamentalStatements.instrumentId, instrumentId));
  const key = (periodEnd: string, periodType: string, source: string) => `${periodEnd}|${periodType}|${source}`;
  const byKey = new Map(existing.map((r) => [key(r.periodEnd, r.periodType, r.source), r]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let earliest: ISODate | null = null;
  for (const s of statements) {
    const old = byKey.get(key(s.periodEnd, s.periodType, s.source));
    const firstSeenAt = old?.firstSeenAt ?? now;
    const { reportedAt, estimated } = resolveReportedAt({
      actual: s.reportedAtActual,
      market,
      periodType: s.periodType as PeriodType,
      periodEnd: s.periodEnd,
      firstSeenAt,
    });
    const values: Record<string, unknown> = {};
    for (const [field, scale] of STATEMENT_NUMERIC) values[field] = fix(s[field], scale);
    if (
      old &&
      STATEMENT_NUMERIC.every(([f]) =>
        eqFix((old as Record<string, unknown>)[f] as string | null, values[f] as string | null),
      ) &&
      old.reportedAt.getTime() === reportedAt.getTime() &&
      old.reportedAtEstimated === estimated
    ) {
      unchanged++;
      continue;
    }
    if (old) updated++;
    else inserted++;
    const visibleFrom = toISO(reportedAt);
    earliest = earliest === null ? visibleFrom : minDate(earliest, visibleFrom);
    const row = {
      instrumentId,
      periodEnd: s.periodEnd,
      periodType: s.periodType,
      reportedAt,
      reportedAtEstimated: estimated,
      firstSeenAt,
      currency: s.currency,
      ...values,
      raw: s.raw ?? null,
      source: s.source,
    };
    await db
      .insert(fundamentalStatements)
      .values(row as typeof fundamentalStatements.$inferInsert)
      .onConflictDoUpdate({
        target: [
          fundamentalStatements.instrumentId,
          fundamentalStatements.periodEnd,
          fundamentalStatements.periodType,
          fundamentalStatements.source,
        ],
        // first_seen_at is deliberately not updated: it is the point-in-time evidence from the first ingest.
        set: {
          reportedAt: sql`excluded.reported_at`,
          reportedAtEstimated: sql`excluded.reported_at_estimated`,
          currency: sql`excluded.currency`,
          revenue: sql`excluded.revenue`,
          grossProfit: sql`excluded.gross_profit`,
          operatingIncome: sql`excluded.operating_income`,
          ebit: sql`excluded.ebit`,
          ebitda: sql`excluded.ebitda`,
          interestExpense: sql`excluded.interest_expense`,
          netIncome: sql`excluded.net_income`,
          epsDiluted: sql`excluded.eps_diluted`,
          sharesDiluted: sql`excluded.shares_diluted`,
          totalAssets: sql`excluded.total_assets`,
          currentAssets: sql`excluded.current_assets`,
          currentLiabilities: sql`excluded.current_liabilities`,
          totalLiabilities: sql`excluded.total_liabilities`,
          longTermDebt: sql`excluded.long_term_debt`,
          totalDebt: sql`excluded.total_debt`,
          cash: sql`excluded.cash`,
          retainedEarnings: sql`excluded.retained_earnings`,
          totalEquity: sql`excluded.total_equity`,
          cfo: sql`excluded.cfo`,
          capex: sql`excluded.capex`,
          fcf: sql`excluded.fcf`,
          dividendsPaid: sql`excluded.dividends_paid`,
          buybacks: sql`excluded.buybacks`,
          raw: sql`excluded.raw`,
        },
      });
  }
  const invalidated = earliest
    ? await invalidateSkillRuns(db, instrumentId, addDays(earliest, -KNOWLEDGE_LOOKBACK_DAYS))
    : 0;
  return { inserted, updated, unchanged, earliestChanged: earliest, invalidated };
}

// ----------------------------------------------------- corporate events
export interface EventInput {
  type: EventType;
  date: ISODate;
  confirmed: boolean;
  source: string;
  details?: Record<string, unknown> | null;
  /** Defaults to `now`; set only to record when something was really learned (point-in-time). */
  knownAt?: Date;
}

export interface WriteEventsOptions {
  /**
   * Delete this source's not-yet-confirmed future events of these types that the new batch no longer contains
   * (Yahoo moves an estimated earnings date; the stale estimate must not linger as a second "next earnings").
   */
  supersede?: { source: string; types: EventType[]; fromDate: ISODate };
}

export async function writeCorporateEvents(
  db: DbOrTx,
  instrumentId: number,
  events: EventInput[],
  now: Date,
  opts: WriteEventsOptions = {},
): Promise<WriteResult> {
  const existing = await db.select().from(corporateEvents).where(eq(corporateEvents.instrumentId, instrumentId));
  const key = (t: string, d: string) => `${t}|${d}`;
  const byKey = new Map(existing.map((r) => [key(r.eventType, r.eventDate), r]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let earliest: ISODate | null = null;
  const touch = (d: ISODate) => {
    earliest = earliest === null ? d : minDate(earliest, d);
  };
  for (const e of events) {
    const old = byKey.get(key(e.type, e.date));
    const knownAt = e.knownAt ?? now;
    if (old) {
      const same =
        old.confirmed === e.confirmed &&
        old.source === e.source &&
        JSON.stringify(old.details ?? null) === JSON.stringify(e.details ?? null);
      if (same) {
        unchanged++;
        continue;
      }
      updated++;
      touch(toISO(old.knownAt));
      await db
        .update(corporateEvents)
        .set({ confirmed: e.confirmed, source: e.source, details: e.details ?? null })
        .where(eq(corporateEvents.id, old.id));
    } else {
      inserted++;
      touch(toISO(knownAt));
      await db.insert(corporateEvents).values({
        instrumentId,
        eventType: e.type,
        eventDate: e.date,
        confirmed: e.confirmed,
        source: e.source,
        knownAt,
        details: e.details ?? null,
      });
    }
  }
  if (opts.supersede) {
    const keep = new Set(events.map((e) => key(e.type, e.date)));
    for (const r of existing) {
      if (
        r.source === opts.supersede.source &&
        !r.confirmed &&
        (opts.supersede.types as string[]).includes(r.eventType) &&
        r.eventDate >= opts.supersede.fromDate &&
        !keep.has(key(r.eventType, r.eventDate))
      ) {
        await db.delete(corporateEvents).where(eq(corporateEvents.id, r.id));
        touch(opts.supersede.fromDate);
      }
    }
  }
  const invalidated = earliest
    ? await invalidateSkillRuns(db, instrumentId, addDays(earliest, -KNOWLEDGE_LOOKBACK_DAYS))
    : 0;
  return { inserted, updated, unchanged, earliestChanged: earliest, invalidated };
}

// --------------------------------------------------------------- FX
export interface FxInput {
  day: ISODate;
  pair: string;
  rate: number;
  source: string;
}

export async function writeFxRates(db: DbOrTx, rates: FxInput[]): Promise<WriteResult> {
  if (rates.length === 0) return { ...EMPTY };
  const sorted = [...rates].sort((a, b) => a.day.localeCompare(b.day));
  const pair = sorted[0]?.pair as string;
  const existing = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.pair, pair), gte(fxRates.day, sorted[0]?.day as string)));
  const byDay = new Map(existing.map((r) => [r.day, r]));
  const toWrite: (typeof fxRates.$inferInsert)[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let earliest: ISODate | null = null;
  for (const r of sorted) {
    const old = byDay.get(r.day);
    const rate = r.rate.toFixed(8);
    if (old && eqFix(old.rate, rate) && old.source === r.source) {
      unchanged++;
      continue;
    }
    if (old) updated++;
    else inserted++;
    earliest = earliest === null ? r.day : minDate(earliest, r.day);
    toWrite.push({ day: r.day, pair: r.pair, rate, source: r.source });
  }
  for (const part of chunks(toWrite)) {
    await db
      .insert(fxRates)
      .values(part)
      .onConflictDoUpdate({
        target: [fxRates.day, fxRates.pair],
        set: { rate: sql`excluded.rate`, source: sql`excluded.source` },
      });
  }
  const invalidated = earliest ? await invalidateAllSkillRuns(db, earliest) : 0;
  return { inserted, updated, unchanged, earliestChanged: earliest, invalidated };
}

// ----------------------------------------------------- option chains
/**
 * Stores one end-of-day snapshot. Chain sources (yahoo, csv) overwrite a same-day snapshot; a `journal` snapshot (a
 * fill, bid = ask = price) never overwrites a real chain quote for the same contract and day.
 */
export async function writeOptionChain(
  db: DbOrTx,
  instrumentId: number,
  snapshot: OptionChainSnapshot,
  now: Date,
): Promise<WriteResult> {
  if (snapshot.quotes.length === 0) return { ...EMPTY };
  const journal = snapshot.source === 'journal';
  let inserted = 0;
  let updated = 0;
  for (const part of chunks(snapshot.quotes, 200)) {
    const contractRows = await db
      .insert(optionContracts)
      .values(
        part.map((q) => ({
          instrumentId,
          right: q.right,
          strike: fix(q.strike, 6) as string,
          expiry: q.expiry,
          multiplier: q.multiplier,
        })),
      )
      .onConflictDoUpdate({
        target: [optionContracts.instrumentId, optionContracts.right, optionContracts.strike, optionContracts.expiry],
        set: { multiplier: sql`excluded.multiplier` },
      })
      .returning({
        id: optionContracts.id,
        right: optionContracts.right,
        strike: optionContracts.strike,
        expiry: optionContracts.expiry,
      });
    const idOf = new Map(contractRows.map((c) => [`${c.right}|${Number(c.strike)}|${c.expiry}`, c.id]));
    const values = part.map((q) => ({
      contractId: idOf.get(`${q.right}|${q.strike}|${q.expiry}`) as number,
      snapshotDate: snapshot.snapshotDate,
      snapshotAt: now,
      bid: fix(q.bid, 6),
      ask: fix(q.ask, 6),
      last: fix(q.last, 6),
      volume: q.volume === null ? null : Math.round(q.volume),
      openInterest: q.openInterest === null ? null : Math.round(q.openInterest),
      iv: fix(q.iv, 6),
      delta: fix(q.delta, 6),
      gamma: fix(q.gamma, 8),
      theta: fix(q.theta, 8),
      vega: fix(q.vega, 8),
      underlyingPrice: fix(snapshot.underlyingPrice, 6) as string,
      tier: snapshot.tier as DataTier,
      source: snapshot.source,
    }));
    const q = db.insert(optionQuotes).values(values);
    const res = journal
      ? await q.onConflictDoNothing().returning({ c: optionQuotes.contractId })
      : await q
          .onConflictDoUpdate({
            target: [optionQuotes.contractId, optionQuotes.snapshotDate],
            set: {
              snapshotAt: sql`excluded.snapshot_at`,
              bid: sql`excluded.bid`,
              ask: sql`excluded.ask`,
              last: sql`excluded.last`,
              volume: sql`excluded.volume`,
              openInterest: sql`excluded.open_interest`,
              iv: sql`excluded.iv`,
              delta: sql`excluded.delta`,
              gamma: sql`excluded.gamma`,
              theta: sql`excluded.theta`,
              vega: sql`excluded.vega`,
              underlyingPrice: sql`excluded.underlying_price`,
              tier: sql`excluded.tier`,
              source: sql`excluded.source`,
            },
          })
          .returning({ c: optionQuotes.contractId });
    inserted += res.length;
    updated += values.length - res.length;
  }
  const invalidated = await invalidateSkillRuns(db, instrumentId, snapshot.snapshotDate);
  return {
    inserted,
    updated,
    unchanged: 0,
    earliestChanged: snapshot.snapshotDate,
    invalidated,
  };
}

// -------------------------------------------------------- IV history
export interface IvDailyInput {
  day: ISODate;
  iv30: number | null;
  iv60?: number | null;
  ivRank?: number | null;
  ivPercentile?: number | null;
  rv20?: number | null;
  rv60?: number | null;
  skew25d?: number | null;
  termRatio?: number | null;
  tier: DataTier;
}

export async function writeIvDaily(db: DbOrTx, instrumentId: number, row: IvDailyInput): Promise<WriteResult> {
  const values = {
    instrumentId,
    day: row.day,
    iv30: fix(row.iv30, 6),
    iv60: fix(row.iv60, 6),
    ivRank: fix(row.ivRank, 2),
    ivPercentile: fix(row.ivPercentile, 2),
    rv20: fix(row.rv20, 6),
    rv60: fix(row.rv60, 6),
    skew25d: fix(row.skew25d, 6),
    termRatio: fix(row.termRatio, 6),
    tier: row.tier,
  };
  const res = await db
    .insert(ivDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [ivDaily.instrumentId, ivDaily.day],
      set: {
        iv30: sql`excluded.iv30`,
        iv60: sql`excluded.iv60`,
        ivRank: sql`excluded.iv_rank`,
        ivPercentile: sql`excluded.iv_percentile`,
        rv20: sql`excluded.rv20`,
        rv60: sql`excluded.rv60`,
        skew25d: sql`excluded.skew_25d`,
        termRatio: sql`excluded.term_ratio`,
        tier: sql`excluded.tier`,
      },
    })
    .returning({ d: ivDaily.day });
  const invalidated = await invalidateSkillRuns(db, instrumentId, row.day);
  return { inserted: res.length, updated: 0, unchanged: 0, earliestChanged: row.day, invalidated };
}

export interface IvHistoryInput {
  day: ISODate;
  iv30: number;
  tier: DataTier;
}

/**
 * Backfills IV history from a provider (OpenD's underlying IV series). A day that already has a row keeps it: the
 * app's own snapshot-derived rows (IV30 interpolated from the chain, with skew and term structure) are the better
 * record, and a provider series must never overwrite them. Cached skill results are invalidated from the earliest
 * day actually inserted, since S3's IV rank at any later as-of now sees a longer series.
 */
export async function writeIvHistory(db: DbOrTx, instrumentId: number, rows: IvHistoryInput[]): Promise<WriteResult> {
  if (rows.length === 0) return { ...EMPTY };
  let inserted = 0;
  let earliest: ISODate | null = null;
  for (const part of chunks(rows)) {
    const res = await db
      .insert(ivDaily)
      .values(part.map((r) => ({ instrumentId, day: r.day, iv30: fix(r.iv30, 6), tier: r.tier })))
      .onConflictDoNothing({ target: [ivDaily.instrumentId, ivDaily.day] })
      .returning({ d: ivDaily.day });
    inserted += res.length;
    for (const r of res) if (earliest === null || r.d < earliest) earliest = r.d;
  }
  const invalidated = earliest ? await invalidateSkillRuns(db, instrumentId, earliest) : 0;
  return { inserted, updated: 0, unchanged: rows.length - inserted, earliestChanged: earliest, invalidated };
}

/** Registry used by tests/db/writers.test.ts. A new `write*` export without an entry here fails the test. */
export const DATA_WRITERS = [
  'writeBars',
  'writeFundamentals',
  'writeCorporateEvents',
  'writeFxRates',
  'writeOptionChain',
  'writeIvDaily',
  'writeIvHistory',
  'writeCalibration',
] as const;

// ------------------------------------------------------------ contracts
export interface ContractSpec {
  strike: number;
  expiry: ISODate;
  multiplier: number;
  right?: 'P' | 'C';
}

/**
 * Creates (or finds) option_contracts rows and returns their ids keyed `P|strike|expiry`. A bare contract row feeds no
 * skill result, so this is not a data writer and needs no cache invalidation; quotes go through writeOptionChain.
 */
export async function ensureOptionContracts(
  db: DbOrTx,
  instrumentId: number,
  specs: ContractSpec[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunks(specs, 200)) {
    const rows = await db
      .insert(optionContracts)
      .values(
        part.map((s) => ({
          instrumentId,
          right: s.right ?? ('P' as const),
          strike: s.strike.toFixed(6),
          expiry: s.expiry,
          multiplier: s.multiplier,
        })),
      )
      .onConflictDoUpdate({
        target: [optionContracts.instrumentId, optionContracts.right, optionContracts.strike, optionContracts.expiry],
        set: { multiplier: sql`excluded.multiplier` },
      })
      .returning({
        id: optionContracts.id,
        right: optionContracts.right,
        strike: optionContracts.strike,
        expiry: optionContracts.expiry,
      });
    for (const r of rows) out.set(`${r.right}|${Number(r.strike)}|${r.expiry}`, r.id);
  }
  return out;
}

/** Calibration samples (real vs synthetic price): reference data for pricing, not a skill input write path. */
export interface CalibrationInput {
  contractId: number;
  day: ISODate;
  realPrice: number;
  syntheticPrice: number;
  sigmaUsed: number;
  spotUsed: number;
  deltaBucket: '0-10' | '10-20' | '20-30' | '30+';
  realSource: string;
  ivRvRatio: number | null;
}

/**
 * Stores calibration samples. They feed the synthetic haircut and the IV/RV ratio read by S3/S4 through DataAccess, so
 * cached results from the earliest sample day are invalidated for the instrument.
 */
export async function writeCalibration(
  db: DbOrTx,
  instrumentId: number,
  rows: CalibrationInput[],
): Promise<WriteResult> {
  if (rows.length === 0) return { ...EMPTY };
  let earliest: ISODate | null = null;
  let inserted = 0;
  for (const part of chunks(rows, 200)) {
    const res = await db
      .insert(pricingCalibration)
      .values(
        part.map((r) => ({
          contractId: r.contractId,
          day: r.day,
          realPrice: r.realPrice.toFixed(6),
          syntheticPrice: r.syntheticPrice.toFixed(6),
          sigmaUsed: r.sigmaUsed.toFixed(6),
          spotUsed: r.spotUsed.toFixed(6),
          deltaBucket: r.deltaBucket,
          realSource: r.realSource,
          ivRvRatio: r.ivRvRatio === null ? null : r.ivRvRatio.toFixed(6),
        })),
      )
      .onConflictDoUpdate({
        target: [pricingCalibration.contractId, pricingCalibration.day, pricingCalibration.realSource],
        set: {
          realPrice: sql`excluded.real_price`,
          syntheticPrice: sql`excluded.synthetic_price`,
          sigmaUsed: sql`excluded.sigma_used`,
          spotUsed: sql`excluded.spot_used`,
          deltaBucket: sql`excluded.delta_bucket`,
          ivRvRatio: sql`excluded.iv_rv_ratio`,
        },
      })
      .returning({ id: pricingCalibration.id });
    inserted += res.length;
  }
  for (const r of rows) earliest = earliest === null ? r.day : minDate(earliest, r.day);
  const invalidated = earliest ? await invalidateSkillRuns(db, instrumentId, earliest) : 0;
  return { inserted, updated: 0, unchanged: 0, earliestChanged: earliest, invalidated };
}
