/**
 * Database-backed backtest run (docs/05, docs/06 Phase 4): loads histories, replays the live pipeline through the
 * engine, computes metrics, benchmarks and the sigma sensitivity, optionally walk-forward, and stores everything in
 * `backtest_runs` / `backtest_trades`. Long-running: it reports progress and honours cancellation between days.
 */
import { and, between, eq, inArray } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import { CALENDAR_FIRST_YEAR, CALENDAR_LAST_YEAR } from '../core/calendar-data';
import type { ISODate } from '../core/dates';
import { type FxPair, fxRate } from '../core/fx';
import { resolveParams, type StrategyParams } from '../core/params';
import type { Currency } from '../core/types';
import { UserError } from '../core/util';
import type { Db } from '../db/client';
import { createRunStore } from '../db/history';
import { getSettings, listWatchlist, loadParams } from '../db/repos';
import { backtestRuns, backtestTrades, optionContracts, optionQuotes } from '../db/schema';
import type { InstrumentHistory } from '../skills/data-access';
import type { RunnerPorts, WatchInstrument } from '../skills/runner';
import {
  type EngineConfig,
  type EngineResult,
  type EngineTrade,
  type EntrySource,
  runEngine,
  type Underlying,
} from './engine';
import { attributionByRule, type EquityPoint, equityMetrics, perStockCards, tradeMetrics } from './metrics';
import { createNaiveSource, NAIVE_DEFAULTS } from './naive-source';
import { createPipelineSource, memoSource } from './pipeline-source';
import { walkForward } from './walk-forward';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface BacktestRequest {
  name?: string;
  /** Default: every active watchlist name. */
  symbols?: { market: Market; symbol: string }[];
  from: ISODate;
  to: ISODate;
  tierPolicy: 'real_only' | 'real_then_synthetic' | 'synthetic_only';
  /** Starting capital in the base currency; default the equity in portfolio settings, else 1,000,000. */
  initialCapital?: number;
  paramsOverride?: DeepPartial<StrategyParams>;
  /** Also record the entries the rules rejected, for per-rule attribution (roughly doubles the compute). */
  observeRejected?: boolean;
  /** Trading days between scans (default 5, weekly). */
  scanEveryDays?: number;
  benchmarks?: boolean;
  sensitivity?: boolean;
  walkForward?: { trainMonths: number; testMonths: number; grid?: DeepPartial<StrategyParams>[] } | null;
}

export interface BacktestRunOptions {
  runId?: string;
  /** Replaces the pipeline as the source of entries (tests and what-if tools); benchmarks and the stored run are unchanged. */
  source?: EntrySource;
  onProgress?(fraction: number, message: string): void;
  shouldCancel?(): boolean;
}

export const DEFAULT_FEES: EngineConfig['feePerContract'] = { US: 0.65, HK: 15 };

export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    // A JSON body can carry an own "__proto__" key; never merge it into the result's prototype chain.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = out[k];
    out[k] =
      v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object'
        ? deepMerge(cur, v as DeepPartial<typeof cur>)
        : v;
  }
  return out as T;
}

/** The engine's per-market haircuts, taken from the strategy parameters (docs/05 section 1 defaults). */
export function haircutsFrom(p: StrategyParams): EngineConfig['haircuts'] {
  const o = p['option.select'];
  return {
    US: { slippage: o.slippageHaircut.US, modelRisk: o.modelRiskHaircut },
    HK: { slippage: o.slippageHaircut.HK, modelRisk: o.modelRiskHaircut },
  };
}

export function assertCalendarRange(from: ISODate, to: ISODate): void {
  const first = `${CALENDAR_FIRST_YEAR}-01-01`;
  const last = `${CALENDAR_LAST_YEAR}-12-31`;
  if (from < first || to > last)
    throw new UserError(
      `a backtest must lie inside the exchange calendar tables (${first} to ${last}); got ${from} to ${to}. Holidays before ${CALENDAR_FIRST_YEAR} are not tabulated, so expiry days there would be guesses`,
    );
  if (from >= to) throw new UserError('the start date must be before the end date');
}

function seriesLookup(fx: InstrumentHistory['fx']): (pair: FxPair, day: ISODate) => number | null {
  return (pair, day) => {
    const s = fx[pair];
    if (!s || s.length === 0) return null;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((s[mid] as { day: string }).day <= day) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? null : (s[lo - 1] as { rate: number }).rate;
  };
}

export function holdEquity(
  underlyings: readonly Underlying[],
  days: ISODate[],
  capital: number,
  fxToBase: (c: Currency, d: ISODate) => number,
): EquityPoint[] {
  const per = capital / Math.max(1, underlyings.length);
  const held = underlyings.map((u) => ({ u, units: 0, last: null as number | null, i: 0 }));
  return days.map((day) => {
    let total = 0;
    for (const h of held) {
      const bars = h.u.bars;
      while (h.i < bars.length && (bars[h.i] as { day: string }).day <= day) {
        h.last = (bars[h.i] as { adjClose: number }).adjClose;
        h.i++;
      }
      // Buy on the first test day (at the last price known then), never at a price from before the window.
      if (h.units === 0 && h.last !== null && h.last > 0) h.units = per / (h.last * fxToBase(h.u.currency, day));
      total += h.last === null ? per : h.units * h.last * fxToBase(h.u.currency, day);
    }
    return { day, equity: total, deployedPct: 1 };
  });
}

function sharpeOf(curve: EquityPoint[], rf: number): number | null {
  return equityMetrics(curve, { riskFree: rf }).sharpe;
}

async function loadRealQuotes(db: Db, ids: number[], from: ISODate, to: ISODate): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: optionContracts.instrumentId,
      strike: optionContracts.strike,
      expiry: optionContracts.expiry,
      day: optionQuotes.snapshotDate,
      bid: optionQuotes.bid,
      ask: optionQuotes.ask,
      last: optionQuotes.last,
      source: optionQuotes.source,
    })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionContracts.id, optionQuotes.contractId))
    .where(
      and(
        inArray(optionContracts.instrumentId, ids),
        eq(optionContracts.right, 'P'),
        between(optionQuotes.snapshotDate, from, to),
      ),
    );
  for (const r of rows) {
    if (r.source === 'journal') continue;
    const bid = r.bid === null ? null : Number(r.bid);
    const ask = r.ask === null ? null : Number(r.ask);
    const price =
      bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : r.last === null ? null : Number(r.last);
    if (price !== null) out.set(`${r.id}|${Number(r.strike)}|${r.expiry}|${r.day}`, price);
  }
  return out;
}

export interface BacktestMetrics {
  trades: ReturnType<typeof tradeMetrics>;
  equity: ReturnType<typeof equityMetrics>;
  cards: ReturnType<typeof perStockCards>;
  attribution: ReturnType<typeof attributionByRule>;
  benchmarks: null | {
    equalWeightHold: ReturnType<typeof equityMetrics>;
    index: Record<string, ReturnType<typeof equityMetrics>>;
    naive: { equity: ReturnType<typeof equityMetrics>; trades: ReturnType<typeof tradeMetrics> };
  };
  sensitivity: null | {
    points: { sigmaMultiplier: number; totalReturn: number | null; sharpe: number | null }[];
    robust: boolean | null;
    note: string;
  };
  tierMix: { real: number; proxy: number; synthetic: number };
  scanDays: number;
  skipped: Record<string, number>;
  caveats: string[];
}

async function prepare(db: Db, req: BacktestRequest) {
  assertCalendarRange(req.from, req.to);
  const base = await loadParams(db);
  let params: StrategyParams;
  try {
    params = resolveParams(deepMerge(base.params, req.paramsOverride));
  } catch (err) {
    throw new UserError(`invalid paramsOverride: ${(err as Error).message.slice(0, 300)}`);
  }
  const settings = await getSettings(db);
  const baseCurrency: Currency = settings.baseCurrency;
  const capital = req.initialCapital ?? settings.equity ?? 1_000_000;
  if (!(capital > 0)) throw new UserError('initial capital must be positive');

  const watch = await listWatchlist(db, { activeOnly: true });
  const chosen = req.symbols?.length
    ? watch.filter((w) => req.symbols?.some((s) => s.market === w.market && s.symbol === w.symbol))
    : watch;
  if (chosen.length === 0) throw new UserError('no watchlist names to test (add names or check the symbols)');
  const instruments: WatchInstrument[] = chosen.map((w) => ({
    ...w,
    conviction: w.conviction,
    maxCollateralPct: w.maxCollateralPct,
  }));
  // The request is stored with the names actually tested, so a later watchlist edit cannot change what a run meant.
  const request = { ...req, symbols: chosen.map((w) => ({ market: w.market, symbol: w.symbol })) };
  const cashRate = baseCurrency === 'USD' ? params['option.select'].riskFreeUS : params['option.select'].riskFreeHK;
  const feeModel = { perContract: DEFAULT_FEES, haircuts: haircutsFrom(params), cashRate };
  return { base, params, baseCurrency, capital, chosen, instruments, request, feeModel, cashRate };
}

async function insertRun(
  db: Db,
  req: BacktestRequest,
  p: Awaited<ReturnType<typeof prepare>>,
  status: 'queued' | 'running',
) {
  const [row] = await db
    .insert(backtestRuns)
    .values({
      name: req.name ?? null,
      paramsId: p.base.id,
      instrumentIds: p.chosen.map((w) => w.id),
      fromDate: req.from,
      toDate: req.to,
      tierPolicy: req.tierPolicy,
      initialCapital: p.capital.toFixed(2),
      feeModel: p.feeModel,
      request: p.request,
      status,
      startedAt: status === 'running' ? new Date() : null,
    })
    .returning({ id: backtestRuns.id });
  return (row as { id: string }).id;
}

/** Validates the request and stores it as a queued run; returns the run id. Nothing is computed yet. */
export async function queueBacktest(db: Db, req: BacktestRequest): Promise<string> {
  return insertRun(db, req, await prepare(db, req), 'queued');
}

/** Runs a previously queued run from its stored request (the scheduler's and the API's entry point). */
export async function runQueuedBacktest(db: Db, runId: string, opts: BacktestRunOptions = {}): Promise<string> {
  const [row] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId));
  if (!row?.request) throw new UserError(`no queued backtest ${runId}`);
  // Claim it atomically: a redelivered job (pg-boss retries and expiry) or a cancelled run must never start a second time,
  // because a second run would append a second copy of the trades.
  const claimed = await db
    .update(backtestRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.status, 'queued')))
    .returning({ id: backtestRuns.id });
  if (claimed.length === 0) return runId;
  return runBacktest(db, row.request as BacktestRequest, { ...opts, runId });
}

export async function runBacktest(db: Db, req: BacktestRequest, opts: BacktestRunOptions = {}): Promise<string> {
  let p: Awaited<ReturnType<typeof prepare>>;
  try {
    p = await prepare(db, req);
  } catch (err) {
    // A queued run whose request no longer validates (watchlist emptied, bad override) must not stay "queued" forever.
    if (opts.runId)
      await db
        .update(backtestRuns)
        .set({ status: 'failed', finishedAt: new Date(), error: (err as Error).message })
        .where(eq(backtestRuns.id, opts.runId));
    throw err;
  }
  let runId = opts.runId;
  if (runId) {
    await db
      .update(backtestRuns)
      .set({ status: 'running', startedAt: new Date(), progress: '0', error: null, request: p.request })
      .where(eq(backtestRuns.id, runId));
  } else runId = await insertRun(db, req, p, 'running');
  const id = runId;

  try {
    const { params, instruments, baseCurrency, capital, cashRate } = p;
    const result = await execute(db, id, { req, params, instruments, baseCurrency, capital, cashRate }, opts);
    await db
      .update(backtestRuns)
      .set({
        status: 'done',
        progress: '100',
        finishedAt: new Date(),
        metrics: result.metrics,
        equityCurve: result.curve,
        walkForward: result.walkForward,
      })
      .where(eq(backtestRuns.id, id));
    return id;
  } catch (err) {
    const cancelled = (err as Error).name === 'BacktestCancelled';
    await db
      .update(backtestRuns)
      .set({ status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date(), error: (err as Error).message })
      .where(eq(backtestRuns.id, id));
    if (cancelled) return id;
    throw err;
  }
}

interface Prepared {
  req: BacktestRequest;
  params: StrategyParams;
  instruments: WatchInstrument[];
  baseCurrency: Currency;
  capital: number;
  cashRate: number;
}

class Cancelled extends Error {
  override name = 'BacktestCancelled';
}

async function execute(db: Db, runId: string, p: Prepared, opts: BacktestRunOptions) {
  const { req, params, instruments, baseCurrency, capital } = p;
  const store = createRunStore(db);
  const progress = (f: number, m: string): void => opts.onProgress?.(Math.min(0.99, f), m);

  const histories = new Map<number, InstrumentHistory>();
  for (const i of instruments) histories.set(i.id, await store.loadHistory(i.id));
  const anyHistory = histories.get(instruments[0]?.id as number) as InstrumentHistory;
  const fxAt = seriesLookup(anyHistory.fx);
  const fxToBase = (ccy: Currency, day: ISODate): number => {
    const r = fxRate(ccy, baseCurrency, (pair) => fxAt(pair, day));
    // A silent 1.0 would value every position in the wrong currency and look plausible: stop and say what is missing.
    if (r === null)
      throw new UserError(
        `no ${ccy} to ${baseCurrency} exchange rate on or before ${day}: run \`ingest --steps fx\` (or start the test later)`,
      );
    return r;
  };
  for (const ccy of new Set(instruments.map((i) => i.currency))) fxToBase(ccy, req.from);

  const underlyings: Underlying[] = instruments.map((i) => {
    const h = histories.get(i.id) as InstrumentHistory;
    return {
      instrumentId: i.id,
      symbol: i.symbol,
      market: i.market,
      currency: i.currency,
      sector: i.sector,
      multiplier: i.multiplier,
      bars: h.bars,
      divYield: 0,
    };
  });

  const ports: RunnerPorts =
    req.tierPolicy === 'synthetic_only'
      ? {
          ...store.ports,
          // hide every stored chain so the pipeline prices synthetically even where snapshots exist
          loadHistory: async (id) => ({ ...(await store.ports.loadHistory(id)), chainAsOf: async () => null }),
        }
      : store.ports;

  const quotes =
    req.tierPolicy === 'synthetic_only'
      ? new Map<string, number>()
      : await loadRealQuotes(
          db,
          instruments.map((i) => i.id),
          req.from,
          req.to,
        );

  const baseConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({
    from: req.from,
    to: req.to,
    initialCapital: capital,
    fxToBase,
    riskFree: { US: params['option.select'].riskFreeUS, HK: params['option.select'].riskFreeHK },
    cashRate: p.cashRate,
    takeProfitPct: 0.5,
    dteExit: 21,
    stopMultiple: 2,
    haircuts: haircutsFrom(params),
    feePerContract: DEFAULT_FEES,
    scanEveryDays: req.scanEveryDays ?? 5,
    maxOpen: 40,
    tierPolicy: req.tierPolicy,
    sigmaMultiplier: 1,
    quoteMid: (id, strike, expiry, day) => quotes.get(`${id}|${strike}|${expiry}|${day}`) ?? null,
    ...over,
  });

  const cancelCheck = (): void => {
    if (opts.shouldCancel?.()) throw new Cancelled('cancelled');
  };
  let lastWritten = -1;

  // ---------------------------------------------------------------- the main run
  const mainSource = memoSource(
    opts.source ??
      createPipelineSource({ ports, instruments, params, baseCurrency, observe: req.observeRejected === true }),
  );
  const mainCfg = baseConfig({
    onDay: (_d, i, total) => {
      cancelCheck();
      const pct = i / Math.max(1, total);
      if (Math.floor(pct * 50) > lastWritten) {
        lastWritten = Math.floor(pct * 50);
        progress(pct * 0.6, `day ${i + 1} of ${total}`);
        // Progress is a courtesy: a failed write must never become an unhandled rejection that ends the process.
        db.update(backtestRuns)
          .set({ progress: (pct * 60).toFixed(2) })
          .where(eq(backtestRuns.id, runId))
          .then(
            () => undefined,
            () => undefined,
          );
      }
    },
  });
  const main: EngineResult = await runEngine(mainCfg, underlyings, mainSource);
  const real = main.trades.filter((t) => !t.shadow);
  const days = main.equity.map((e) => e.day);

  // ---------------------------------------------------------------- benchmarks
  let benchmarks: BacktestMetrics['benchmarks'] = null;
  if (req.benchmarks !== false) {
    progress(0.65, 'benchmarks');
    cancelCheck();
    const naive = await runEngine(
      baseConfig({ onDay: undefined }),
      underlyings,
      createNaiveSource(underlyings, {
        ...NAIVE_DEFAULTS,
        riskFree: { US: params['option.select'].riskFreeUS, HK: params['option.select'].riskFreeHK },
        haircuts: haircutsFrom(params),
        skewBumpPer10Delta: params['option.select'].skewBumpPer10Delta,
        ivRvRatio: params['volatility.edge'].ivRvRatioDefault,
        maxPerNamePct: params['size.position'].maxPerNamePct,
      }),
    );
    const index: Record<string, ReturnType<typeof equityMetrics>> = {};
    for (const m of new Set(instruments.map((i) => i.market))) {
      const h = [...histories.values()].find((x) => x.instrument.market === m);
      if (!h) continue;
      const bars = h.indexBars.filter((b) => b.day >= req.from && b.day <= req.to);
      const first = bars[0];
      if (!first) continue;
      index[h.indexSymbol] = equityMetrics(
        bars.map((b) => ({ day: b.day, equity: (capital * b.adjClose) / first.adjClose, deployedPct: 1 })),
      );
    }
    benchmarks = {
      equalWeightHold: equityMetrics(holdEquity(underlyings, days, capital, fxToBase)),
      index,
      naive: { equity: equityMetrics(naive.equity, { riskFree: p.cashRate }), trades: tradeMetrics(naive.trades) },
    };
  }

  // ---------------------------------------------------------------- sigma sensitivity (docs/05 section 6.4)
  let sensitivity: BacktestMetrics['sensitivity'] = null;
  const synthetic = real.filter((t) => t.tier !== 'real').length;
  if (req.sensitivity !== false && synthetic > 0) {
    progress(0.75, 'sensitivity');
    const points = [
      {
        sigmaMultiplier: 1,
        totalReturn: equityMetrics(main.equity).totalReturn,
        sharpe: sharpeOf(main.equity, p.cashRate),
      },
    ];
    for (const k of [0.8, 1.2]) {
      cancelCheck();
      const r = await runEngine(baseConfig({ sigmaMultiplier: k, onDay: undefined }), underlyings, mainSource);
      points.push({
        sigmaMultiplier: k,
        totalReturn: equityMetrics(r.equity).totalReturn,
        sharpe: sharpeOf(r.equity, p.cashRate),
      });
    }
    const signs = points.map((x) => Math.sign(x.totalReturn ?? 0));
    const flips = new Set(signs).size > 1;
    sensitivity = {
      points,
      robust: !flips,
      note: flips
        ? 'not robust to pricing error: the sign of the result flips when the model volatility moves by 20%'
        : 'the sign of the result holds when the model volatility moves by 20%',
    };
  }

  // ---------------------------------------------------------------- walk-forward
  let wf: unknown = null;
  if (req.walkForward) {
    const grid: DeepPartial<StrategyParams>[] = req.walkForward.grid ?? [
      { 'option.select': { deltaMax: 0.25 }, 'size.position': { maxPerNamePct: 0.03 } },
      { 'option.select': { deltaMax: 0.25 }, 'size.position': { maxPerNamePct: 0.05 } },
      { 'option.select': { deltaMax: 0.3 }, 'size.position': { maxPerNamePct: 0.03 } },
      { 'option.select': { deltaMax: 0.3 }, 'size.position': { maxPerNamePct: 0.05 } },
    ];
    const total = grid.length;
    let done = 0;
    wf = await walkForward<DeepPartial<StrategyParams>>({
      from: req.from,
      to: req.to,
      trainMonths: req.walkForward.trainMonths,
      testMonths: req.walkForward.testMonths,
      grid,
      evaluate: async (g, from, to) => {
        cancelCheck();
        const prm = resolveParams(deepMerge(params, g));
        const src =
          opts.source ?? createPipelineSource({ ports, instruments, params: prm, baseCurrency, observe: false });
        const r = await runEngine(
          { ...baseConfig({ onDay: undefined }), from, to, haircuts: haircutsFrom(prm) },
          underlyings,
          src,
        );
        done++;
        progress(0.8 + 0.19 * Math.min(1, done / (total * 8)), 'walk-forward');
        const m = equityMetrics(r.equity, { riskFree: p.cashRate });
        return { sharpe: m.sharpe, totalReturn: m.totalReturn, n: r.trades.filter((t) => !t.shadow).length };
      },
    });
  }

  // ---------------------------------------------------------------- assemble and store
  const tierMix = { real: 0, proxy: 0, synthetic: 0 };
  for (const t of real) tierMix[t.tier]++;
  const caveats = [
    'Survivorship: the watchlist is names you like today, so this is a "names I like today" backtest (docs/05 section 3).',
    `Prices before the first stored chain snapshot are synthetic (Black-Scholes / Barone-Adesi-Whaley on realised volatility); ${synthetic} of ${real.length} trades used them.`,
    'Entries fill at the close of the signal day; exits triggered on a close fill at the next close. Assignment is booked at intrinsic value like the journal.',
    'Dividends are not modelled in synthetic prices (yield 0).',
    `Cash and collateral earn a flat ${(p.cashRate * 100).toFixed(1)}% a year (a strategy parameter), not the real rate history; every benchmark comparison inherits that.`,
  ];
  const hkUncalibrated = [...histories.values()].some(
    (h) => h.instrument.market === 'HK' && h.calibration.length < params['volatility.edge'].calibrationMinSamples,
  );
  if (hkUncalibrated && instruments.some((i) => i.market === 'HK'))
    caveats.push('HK synthetic prices uncalibrated, indicative only (fewer than the minimum real/synthetic samples).');
  if (sensitivity && sensitivity.points.length > 0)
    caveats.push(
      "Sensitivity runs reuse the base run's entries and sizes and re-price them, so they measure pricing error only.",
    );
  if (req.observeRejected !== true)
    caveats.push('Per-rule attribution needs observe mode (observeRejected); without it only passed entries exist.');

  const metrics: BacktestMetrics = {
    trades: tradeMetrics(real),
    equity: equityMetrics(main.equity, { riskFree: p.cashRate }),
    cards: perStockCards(real, req.from, req.to),
    attribution: attributionByRule(req.observeRejected === true ? main.trades : real),
    benchmarks,
    sensitivity,
    tierMix,
    scanDays: main.scanDays,
    skipped: main.skipped,
    caveats,
  };

  await db.delete(backtestTrades).where(eq(backtestTrades.backtestRunId, runId));
  for (let i = 0; i < main.trades.length; i += 500) {
    await db.insert(backtestTrades).values(main.trades.slice(i, i + 500).map((t) => tradeRow(runId, t)));
  }
  return {
    metrics,
    curve: main.equity.map((e) => [e.day, Math.round(e.equity * 100) / 100, Math.round(e.deployedPct * 10000) / 10000]),
    walkForward: wf,
  };
}

function tradeRow(runId: string, t: EngineTrade) {
  return {
    backtestRunId: runId,
    instrumentId: t.instrumentId,
    entryDate: t.entryDate,
    expiry: t.expiry,
    strike: t.strike.toFixed(6),
    multiplier: t.multiplier,
    entryCredit: t.entryCredit.toFixed(6),
    entryDelta: t.entryDelta === null || t.entryDelta === undefined ? null : t.entryDelta.toFixed(6),
    entryIv: t.entryIv === null ? null : t.entryIv.toFixed(6),
    entryUnderlying: t.entryUnderlying.toFixed(6),
    contracts: t.contracts,
    exitDate: t.exitDate,
    exitReason: t.exitReason,
    exitDebit: t.exitDebit.toFixed(6),
    exitUnderlying: t.exitUnderlying.toFixed(6),
    pnl: t.pnl.toFixed(6),
    roc: t.roc.toFixed(6),
    annualizedRoc: Math.max(-9999, Math.min(9999, t.annualizedRoc)).toFixed(6),
    daysHeld: t.daysHeld,
    maxAdverseExcursion: t.maxAdverseExcursion === null ? null : t.maxAdverseExcursion.toFixed(6),
    tier: t.tier,
    scores: { ...(t.scores ?? {}), symbol: t.symbol, currency: t.currency, collateralBase: t.collateral },
  };
}
