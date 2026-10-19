/**
 * Database-backed inputs for the pure runner: the per-run history loader, the skill-run cache and the portfolio state.
 *
 * `createRunStore` caches market-level data (index bars, FX) for the life of one run and loads each instrument's
 * history exactly once: one `price_bars` query per instrument plus one per index instrument (T9). Skills never see
 * this module: they receive a `DataAccess` that slices the in-memory history at asOf.
 */
import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { BENCHMARK_SYMBOL, VOL_INDEX_SYMBOL } from '../core/benchmarks';
import type { Market } from '../core/calendar';
import type { DeltaBucket } from '../core/contracts';
import type { ISODate } from '../core/dates';
import { FX_PAIRS, type FxPair, fxRate } from '../core/fx';
import type {
  CalibrationRow,
  CorporateEvent,
  Currency,
  DailyBar,
  EventType,
  FundamentalStatement,
  Instrument,
  JournalOutcome,
  OptionChainSnapshot,
  OptionQuote,
  PeriodType,
  PortfolioState,
} from '../core/types';
import { num } from '../core/util';
import type { SkillResult } from '../skills/contract';
import type { InstrumentHistory, PortfolioLedger } from '../skills/data-access';
import type { RunnerPorts } from '../skills/runner';
import type { Db } from './client';
import { findInstrument, getInstrument, getSettings, listOpenPositions } from './repos';
import {
  corporateEvents,
  fundamentalStatements,
  fxRates,
  instruments,
  ivDaily,
  optionContracts,
  optionQuotes,
  positionMarks,
  positions,
  priceBars,
  pricingCalibration,
  skillRuns,
} from './schema';

const n = (x: string | null | undefined): number | null => num(x);

function toBar(r: typeof priceBars.$inferSelect): DailyBar {
  return {
    day: r.day,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    adjClose: Number(r.adjClose),
    volume: r.volume,
    source: r.source,
  };
}

export async function loadBars(db: Db, instrumentId: number): Promise<DailyBar[]> {
  const rows = await db
    .select()
    .from(priceBars)
    .where(eq(priceBars.instrumentId, instrumentId))
    .orderBy(asc(priceBars.day));
  return rows.map(toBar);
}

function toStatement(r: typeof fundamentalStatements.$inferSelect): FundamentalStatement {
  return {
    periodEnd: r.periodEnd,
    periodType: r.periodType as PeriodType,
    reportedAt: r.reportedAt.toISOString(),
    reportedAtEstimated: r.reportedAtEstimated,
    firstSeenAt: r.firstSeenAt.toISOString(),
    currency: r.currency as Currency,
    revenue: n(r.revenue),
    grossProfit: n(r.grossProfit),
    operatingIncome: n(r.operatingIncome),
    ebit: n(r.ebit),
    ebitda: n(r.ebitda),
    interestExpense: n(r.interestExpense),
    netIncome: n(r.netIncome),
    epsDiluted: n(r.epsDiluted),
    sharesDiluted: n(r.sharesDiluted),
    totalAssets: n(r.totalAssets),
    currentAssets: n(r.currentAssets),
    currentLiabilities: n(r.currentLiabilities),
    totalLiabilities: n(r.totalLiabilities),
    longTermDebt: n(r.longTermDebt),
    totalDebt: n(r.totalDebt),
    cash: n(r.cash),
    retainedEarnings: n(r.retainedEarnings),
    totalEquity: n(r.totalEquity),
    cfo: n(r.cfo),
    capex: n(r.capex),
    fcf: n(r.fcf),
    dividendsPaid: n(r.dividendsPaid),
    buybacks: n(r.buybacks),
    source: r.source,
  };
}

/** Latest non-journal chain snapshot with snapshot_date <= asOf for one instrument. Journal fills are not chains. */
export async function loadChainAsOf(db: Db, instrumentId: number, asOf: ISODate): Promise<OptionChainSnapshot | null> {
  const [latest] = await db
    .select({ d: sql<string | null>`max(${optionQuotes.snapshotDate})` })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionContracts.id, optionQuotes.contractId))
    .where(
      and(
        eq(optionContracts.instrumentId, instrumentId),
        lte(optionQuotes.snapshotDate, asOf),
        ne(optionQuotes.source, 'journal'),
      ),
    );
  if (!latest?.d) return null;
  const rows = await db
    .select({ c: optionContracts, q: optionQuotes })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionContracts.id, optionQuotes.contractId))
    .where(
      and(
        eq(optionContracts.instrumentId, instrumentId),
        eq(optionQuotes.snapshotDate, latest.d),
        ne(optionQuotes.source, 'journal'),
      ),
    );
  if (rows.length === 0) return null;
  const first = (rows[0] as (typeof rows)[number]).q;
  const quotes: OptionQuote[] = rows.map(({ c, q }) => ({
    expiry: c.expiry,
    strike: Number(c.strike),
    right: c.right,
    bid: n(q.bid),
    ask: n(q.ask),
    last: n(q.last),
    volume: n(q.volume === null ? null : String(q.volume)),
    openInterest: n(q.openInterest === null ? null : String(q.openInterest)),
    iv: n(q.iv),
    delta: n(q.delta),
    gamma: n(q.gamma),
    theta: n(q.theta),
    vega: n(q.vega),
    multiplier: c.multiplier,
  }));
  return {
    snapshotDate: latest.d,
    underlyingPrice: Number(first.underlyingPrice),
    source: first.source.split('+')[0] as OptionChainSnapshot['source'],
    tier: first.tier,
    quotes,
  };
}

interface Shared {
  indexBars: Map<number, DailyBar[]>;
  fx: Partial<Record<FxPair, { day: ISODate; rate: number }[]>> | null;
  ids: Map<string, Instrument | null>;
  ledger: Promise<PortfolioLedger> | null;
}

/** Every recorded put with its currency, and every stored mark: the drawdown governor's input, loaded once per run. */
export async function loadLedger(db: Db): Promise<PortfolioLedger> {
  const rows = await db
    .select({
      id: positions.id,
      currency: instruments.currency,
      openDate: positions.openDate,
      closeDate: positions.closeDate,
      realizedPnl: positions.realizedPnl,
    })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .orderBy(asc(positions.openDate), asc(positions.id));
  const marks = await db
    .select({
      positionId: positionMarks.positionId,
      day: positionMarks.day,
      unrealizedPnl: positionMarks.unrealizedPnl,
    })
    .from(positionMarks)
    .orderBy(asc(positionMarks.day));
  return {
    positions: rows.map((r) => ({
      positionId: r.id,
      currency: r.currency as Currency,
      openDate: r.openDate,
      closeDate: r.closeDate,
      realizedPnl: r.realizedPnl === null ? null : Number(r.realizedPnl),
    })),
    marks: marks.map((m) => ({ positionId: m.positionId, day: m.day, unrealizedPnl: Number(m.unrealizedPnl) })),
  };
}

export interface RunStore {
  ports: RunnerPorts;
  /** Number of price_bars queries issued so far (T9 test hook). */
  barQueries(): number;
  loadHistory(instrumentId: number): Promise<InstrumentHistory>;
}

export function createRunStore(db: Db, opts: { timer?: () => number } = {}): RunStore {
  const shared: Shared = { indexBars: new Map(), fx: null, ids: new Map(), ledger: null };
  const ledger = (): Promise<PortfolioLedger> => {
    if (!shared.ledger) shared.ledger = loadLedger(db);
    return shared.ledger;
  };
  const histories = new Map<number, Promise<InstrumentHistory>>();
  let barQueryCount = 0;
  const countedBars = async (id: number): Promise<DailyBar[]> => {
    barQueryCount++;
    return loadBars(db, id);
  };
  const instrumentBySymbol = async (market: Market, symbol: string): Promise<Instrument | null> => {
    const key = `${market}|${symbol}`;
    if (!shared.ids.has(key)) shared.ids.set(key, await findInstrument(db, market, symbol));
    return shared.ids.get(key) ?? null;
  };
  const indexBarsFor = async (inst: Instrument | null): Promise<DailyBar[]> => {
    if (!inst) return [];
    if (!shared.indexBars.has(inst.id)) shared.indexBars.set(inst.id, await countedBars(inst.id));
    return shared.indexBars.get(inst.id) as DailyBar[];
  };
  const fxSeries = async (): Promise<NonNullable<Shared['fx']>> => {
    if (!shared.fx) {
      const rows = await db
        .select()
        .from(fxRates)
        .where(inArray(fxRates.pair, [...FX_PAIRS]))
        .orderBy(asc(fxRates.day));
      const out: NonNullable<Shared['fx']> = {};
      for (const r of rows) {
        const pair = r.pair as FxPair;
        const list = out[pair] ?? [];
        list.push({ day: r.day, rate: Number(r.rate) });
        out[pair] = list;
      }
      shared.fx = out;
    }
    return shared.fx;
  };

  const loadOne = async (instrumentId: number): Promise<InstrumentHistory> => {
    const inst = await getInstrument(db, instrumentId);
    if (!inst) throw new Error(`instrument ${instrumentId} not found`);
    const bars = await countedBars(instrumentId);
    // HK regime and relative strength: docs/01 allows 'HSI or 2800.HK'. Use whichever is fresher (Yahoo's 2800.HK tracker
    // sometimes lags the index by a session); ties keep the tracker.
    const bench = await instrumentBySymbol(inst.market, BENCHMARK_SYMBOL[inst.market]);
    const ref = inst.market === 'HK' ? await instrumentBySymbol('HK', 'HSI') : null;
    const benchBars = await indexBarsFor(bench);
    const refBars = ref ? await indexBarsFor(ref) : [];
    const useRef =
      refBars.length > 0 &&
      (benchBars.length === 0 ||
        (refBars[refBars.length - 1]?.day as string) > (benchBars[benchBars.length - 1]?.day as string));
    const vol = await instrumentBySymbol(inst.market, VOL_INDEX_SYMBOL[inst.market]);
    const [stmts, evs, ivs, calib, journal] = await Promise.all([
      db.select().from(fundamentalStatements).where(eq(fundamentalStatements.instrumentId, instrumentId)),
      db.select().from(corporateEvents).where(eq(corporateEvents.instrumentId, instrumentId)),
      db.select().from(ivDaily).where(eq(ivDaily.instrumentId, instrumentId)).orderBy(asc(ivDaily.day)),
      loadCalibrationRows(db, instrumentId),
      loadJournalOutcomes(db, instrumentId),
    ]);
    return {
      instrument: inst,
      bars,
      indexSymbol: useRef ? 'HSI' : BENCHMARK_SYMBOL[inst.market],
      indexBars: useRef ? refBars : benchBars,
      volIndexSymbol: VOL_INDEX_SYMBOL[inst.market],
      volIndexBars: await indexBarsFor(vol),
      statements: stmts.map(toStatement),
      events: evs.map(
        (e): CorporateEvent => ({
          type: e.eventType as EventType,
          date: e.eventDate,
          confirmed: e.confirmed,
          source: e.source,
          knownAt: e.knownAt.toISOString(),
          details: e.details,
        }),
      ),
      ivPoints: ivs
        .filter((r) => r.iv30 !== null)
        .map((r) => ({
          day: r.day,
          iv30: Number(r.iv30),
          tier: r.tier,
          skew25d: n(r.skew25d),
          termRatio: n(r.termRatio),
        })),
      chainAsOf: (asOf) => loadChainAsOf(db, instrumentId, asOf),
      fx: await fxSeries(),
      calibration: calib,
      journal,
      ledger: await ledger(),
    };
  };

  const loadHistory = (id: number): Promise<InstrumentHistory> => {
    let p = histories.get(id);
    if (!p) {
      p = loadOne(id);
      histories.set(id, p);
    }
    return p;
  };

  const ports: RunnerPorts = {
    loadHistory,
    async cacheGet(instrumentId, asOf, skillId, version, hash) {
      const [r] = await db
        .select()
        .from(skillRuns)
        .where(
          and(
            eq(skillRuns.instrumentId, instrumentId),
            eq(skillRuns.asOf, asOf),
            eq(skillRuns.skillId, skillId),
            eq(skillRuns.skillVersion, version),
            eq(skillRuns.paramsHash, hash),
          ),
        );
      if (!r) return null;
      return {
        skillId: r.skillId,
        version: r.skillVersion,
        score: n(r.score),
        verdict: r.verdict,
        reasons: r.reasons,
        payload: r.payload,
        dataQuality: { tier: r.dataTier, missing: r.missing },
      };
    },
    async cachePut(instrumentId, asOf, hash, result: SkillResult, durationMs) {
      await db
        .insert(skillRuns)
        .values({
          instrumentId,
          asOf,
          skillId: result.skillId,
          skillVersion: result.version,
          paramsHash: hash,
          score: result.score === null ? null : result.score.toFixed(2),
          verdict: result.verdict,
          reasons: result.reasons,
          payload: result.payload as object,
          dataTier: result.dataQuality.tier,
          missing: result.dataQuality.missing,
          durationMs,
        })
        .onConflictDoNothing();
    },
    timer: opts.timer ?? (() => performance.now()),
  };
  return { ports, barQueries: () => barQueryCount, loadHistory };
}

// ------------------------------------------------------- calibration and journal rows
export async function loadCalibrationRows(db: Db, instrumentId: number): Promise<CalibrationRow[]> {
  const rows = await db
    .select({ p: pricingCalibration })
    .from(pricingCalibration)
    .innerJoin(optionContracts, eq(optionContracts.id, pricingCalibration.contractId))
    .where(eq(optionContracts.instrumentId, instrumentId));
  return rows
    .map(({ p }) => ({
      day: p.day,
      bucket: p.deltaBucket as DeltaBucket,
      ratio: Number(p.syntheticPrice) > 0 ? Number(p.realPrice) / Number(p.syntheticPrice) : Number.NaN,
      ivRvRatio: n(p.ivRvRatio),
      source: p.realSource,
    }))
    .filter((r) => Number.isFinite(r.ratio));
}

export async function loadJournalOutcomes(db: Db, instrumentId: number): Promise<JournalOutcome[]> {
  const rows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.instrumentId, instrumentId),
        eq(positions.source, 'journal_import'),
        ne(positions.status, 'open'),
      ),
    );
  return rows
    .filter((p) => p.realizedPnl !== null && p.closeDate !== null)
    .map((p) => ({
      openDate: p.openDate,
      closeDate: p.closeDate as string,
      pnl: Number(p.realizedPnl),
      collateral: Number(p.strike) * p.multiplier * p.quantity,
    }));
}

// ------------------------------------------------------------------ portfolio
/** Portfolio state for a run: equity, open positions and FX to the base currency, as of `asOf`. */
export async function loadPortfolio(db: Db, asOf: ISODate): Promise<PortfolioState> {
  const settings = await getSettings(db);
  const open = await listOpenPositions(db);
  const rates: Partial<Record<FxPair, number>> = {};
  for (const pair of FX_PAIRS) {
    const [r] = await db
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.pair, pair), lte(fxRates.day, asOf)))
      .orderBy(desc(fxRates.day))
      .limit(1);
    if (r) rates[pair] = Number(r.rate);
  }
  return {
    baseCurrency: settings.baseCurrency,
    equity: settings.equity,
    openPositions: open.map(({ positionId: _p, ...o }) => o),
    fxToBase: (from) => fxRate(from, settings.baseCurrency, (pair) => rates[pair] ?? null),
    governor: settings.governor,
  };
}
