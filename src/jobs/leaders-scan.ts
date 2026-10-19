/**
 * The Leaders scan (docs/designs/leaders-pullback.md, stage L1/L3): one market, one as-of date.
 *
 *   1. the returns pass over every universe name (plus the watchlist) with enough bars, and the market's rank table;
 *   2. the `leaders.pullback` skill over the names that are leaders, and over names that were on the previous list (so the
 *      dropped row can say why);
 *   3. the score, the market's own list (rank), one `leaders_runs` row and one `leaders_candidates` row per name that reached
 *      the leader test or better;
 *   4. outcome stamping for earlier Setups from the bars that have arrived since.
 *
 * It never calls a model, never writes to recommendations, positions, research verdicts or corporate events, and reads no
 * clock of its own besides the injected `now`.
 */
import { BENCHMARK_SYMBOL, VOL_INDEX_SYMBOL } from '../core/benchmarks';
import { lastTradingDayOnOrBefore, type Market } from '../core/calendar';
import { addDays, type ISODate } from '../core/dates';
import { computeOutcome, type LeaderState, type LeadersPayload, percentRank } from '../core/leaders';
import type { LeadersPullbackParams, StrategyParams } from '../core/params';
import { yahooSymbol } from '../core/symbols';
import type { CorporateEvent, DailyBar, Instrument } from '../core/types';
import type { Db } from '../db/client';
import { loadBars, loadPortfolio } from '../db/history';
import {
  activeMutes,
  candidatesAwaitingOutcome,
  failRun,
  finishRun,
  insertCandidates,
  insertRun,
  listedInstrumentIds,
  listScreenInstruments,
  loadBarsMany,
  loadUpcomingEvents,
  type NewCandidate,
  previousRun,
  writeOutcome,
} from '../db/leaders';
import { findInstrument, loadParams } from '../db/repos';
import type { YahooClient } from '../providers/yahoo/client';
import { normalizeCalendar } from '../providers/yahoo/normalize';
import {
  createDataAccess,
  type InstrumentHistory,
  LEADERS_EARNINGS_KEY,
  LEADERS_RANKS_KEY,
  type LeadersEarningsInput,
  type LeadersRankInput,
  leaderRule,
  leadersPullback,
  leadersScreen,
  type SkillContext,
  type SkillResult,
} from '../skills';
import { marketRegime, type RegimePayload } from '../skills/s0-market-regime';

const MARKET_TZ: Record<Market, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong' };
/** How far back the scan reads bars: the longest window any rule needs is 6 months, the rest is slack for holidays. */
const BAR_LOOKBACK_DAYS = 520;
const EARNINGS_CONCURRENCY = 4;

/** The last completed session of a market: from 16:30 local (the close plus 30 minutes) the market's own date counts, before that the day before. */
export function leadersAsOf(market: Market, now: Date): ISODate {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: MARKET_TZ[market],
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const local = `${parts.year}-${parts.month}-${parts.day}`;
  return lastTradingDayOnOrBefore(
    market,
    Number(parts.hour) * 60 + Number(parts.minute) >= 16 * 60 + 30 ? local : addDays(local, -1),
  );
}

export interface EarningsLookup {
  earnings: ISODate | null;
  exDividend: ISODate | null;
}

/** The next earnings and ex-dividend dates of a name from Yahoo's calendar; null when the call fails. */
export function yahooEarningsPort(client: YahooClient): (i: Instrument) => Promise<EarningsLookup | null> {
  return async (inst) => {
    const given = inst.providerSymbols.yahoo;
    const sym = typeof given === 'string' && given ? given : yahooSymbol(inst.market, inst.symbol);
    try {
      const cal = normalizeCalendar(await client.calendar(sym), inst.market);
      return { earnings: cal.earnings[0]?.date ?? null, exDividend: cal.exDividend };
    } catch {
      return null;
    }
  };
}

export interface LeadersScanDeps {
  db: Db;
  now(): Date;
  log(line: string): void;
  /** Looks up earnings dates for the names that are leaders; without it the dates come from stored events only. */
  earnings?: (i: Instrument) => Promise<EarningsLookup | null>;
}

export interface LeadersScanOptions {
  market: Market;
  asOf?: ISODate;
}

export interface LeadersScanResult {
  runId: number;
  market: Market;
  asOf: ISODate;
  status: 'ok' | 'partial';
  names: number;
  screened: number;
  leaders: number;
  consolidating: number;
  shortlisted: number;
  setups: number;
  watches: number;
  regime: string | null;
  posture: 'entries' | 'watch_only';
  coverage: { withBar: number; names: number };
  durationMs: number;
  outcomesStamped: number;
}

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

interface IndexBars {
  indexSymbol: string;
  indexBars: DailyBar[];
  volIndexSymbol: string;
  volIndexBars: DailyBar[];
}

/** Benchmark and vol-index bars the regime and the relative-strength rows need (HK: the fresher of 2800 and HSI). */
async function loadIndexBars(db: Db, market: Market): Promise<IndexBars> {
  const bench = await findInstrument(db, market, BENCHMARK_SYMBOL[market]);
  const ref = market === 'HK' ? await findInstrument(db, 'HK', 'HSI') : null;
  const vol = await findInstrument(db, market, VOL_INDEX_SYMBOL[market]);
  const benchBars = bench ? await loadBars(db, bench.id) : [];
  const refBars = ref ? await loadBars(db, ref.id) : [];
  const useRef =
    refBars.length > 0 &&
    (benchBars.length === 0 ||
      (refBars[refBars.length - 1]?.day as string) > (benchBars[benchBars.length - 1]?.day as string));
  return {
    indexSymbol: useRef ? 'HSI' : BENCHMARK_SYMBOL[market],
    indexBars: useRef ? refBars : benchBars,
    volIndexSymbol: VOL_INDEX_SYMBOL[market],
    volIndexBars: vol ? await loadBars(db, vol.id) : [],
  };
}

function stubInstrument(market: Market): Instrument {
  return {
    id: 0,
    market,
    symbol: BENCHMARK_SYMBOL[market],
    name: null,
    currency: market === 'HK' ? 'HKD' : 'USD',
    sector: 'INDEX',
    industry: null,
    solvencyModel: 'altman',
    reportingFrequency: 'quarterly',
    benchmarkInstrumentId: null,
    multiplier: 1,
    hasListedOptions: false,
    providerSymbols: {},
  };
}

/** Runs the scan of one market and stores it. Throws after marking the run failed when something breaks. */
export async function runLeadersScan(deps: LeadersScanDeps, opts: LeadersScanOptions): Promise<LeadersScanResult> {
  const { market } = opts;
  const started = deps.now();
  const t0 = performance.now();
  const asOf = opts.asOf ?? leadersAsOf(market, started);
  const loaded = await loadParams(deps.db);
  const params = loaded.params;
  const p = params['leaders.pullback'];
  const runId = await insertRun(deps.db, {
    market,
    asOf,
    startedAt: started,
    paramsHash: loaded.hash,
    skillVersion: leadersPullback.version,
  });
  try {
    const result = await scanBody(deps, { market, asOf, runId, params, p, started, t0 });
    return result;
  } catch (err) {
    await failRun(deps.db, runId, deps.now(), (err as Error).message);
    throw err;
  }
}

async function scanBody(
  deps: LeadersScanDeps,
  o: {
    market: Market;
    asOf: ISODate;
    runId: number;
    params: StrategyParams;
    p: LeadersPullbackParams;
    started: Date;
    t0: number;
  },
): Promise<LeadersScanResult> {
  const { db } = deps;
  const { market, asOf, runId, params, p } = o;
  const screenSet = await listScreenInstruments(db, market);
  const mutes = await activeMutes(db, asOf);
  const scanned = screenSet.filter((s) => !mutes.has(s.instrument.id));
  const bars = await loadBarsMany(
    db,
    scanned.map((s) => s.instrument.id),
    addDays(asOf, -BAR_LOOKBACK_DAYS),
  );
  const index = await loadIndexBars(db, market);
  const portfolio = await loadPortfolio(db, asOf);

  // ------------------------------------------------------------------------ pass 1: returns and the rank table
  const rows = scanned.map((s) => {
    const own = bars.get(s.instrument.id) ?? [];
    const upTo = own.filter((b) => b.day <= asOf);
    return { s, bars: upTo, screen: leadersScreen(upTo, asOf, market, p) };
  });
  const withBars = rows.filter((r) => r.bars.length > 0);
  const withAsOfBar = withBars.filter((r) => r.bars[r.bars.length - 1]?.day === asOf);
  const eligible = rows.filter((r) => r.screen.eligible);
  const sorted = (pick: (r: (typeof eligible)[number]) => number): number[] => eligible.map(pick).sort((a, b) => a - b);
  const r1 = sorted((r) => r.screen.ret1m as number);
  const r3 = sorted((r) => r.screen.ret3m as number);
  const r6 = sorted((r) => r.screen.ret6m as number);
  const ranksOf = new Map<number, LeadersRankInput>();
  for (const r of eligible)
    ranksOf.set(r.s.instrument.id, {
      rank1m: percentRank(r1, r.screen.ret1m as number),
      rank3m: percentRank(r3, r.screen.ret3m as number),
      rank6m: percentRank(r6, r.screen.ret6m as number),
      screened: eligible.length,
    });
  const leaders = eligible.filter((r) => {
    const rk = ranksOf.get(r.s.instrument.id) as LeadersRankInput;
    return leaderRule(r.screen, rk, p).isLeader;
  });

  // ---------------------------------------------- the names the skill runs on: leaders, and last list's names
  const prev = await previousRun(db, market, asOf);
  const prevIds = new Set(prev ? await listedInstrumentIds(db, prev.id) : []);
  const leaderIds = new Set(leaders.map((r) => r.s.instrument.id));
  const candidates = rows.filter((r) => leaderIds.has(r.s.instrument.id) || prevIds.has(r.s.instrument.id));

  // earnings dates: stored events for the names the user follows, Yahoo's calendar for the other leaders
  const watchIds = candidates.filter((r) => r.s.onWatchlist).map((r) => r.s.instrument.id);
  const stored = await loadUpcomingEvents(db, watchIds, asOf);
  const looked = new Map<number, LeadersEarningsInput>();
  if (deps.earnings) {
    const lookup = deps.earnings;
    const todo = leaders.filter((r) => !r.s.onWatchlist);
    const answers = await pool(todo, EARNINGS_CONCURRENCY, (r) => lookup(r.s.instrument));
    todo.forEach((r, i) => {
      const a = answers[i];
      if (a) looked.set(r.s.instrument.id, { earnings: a.earnings, exDividend: a.exDividend });
    });
  }

  // ------------------------------------------------------------------------------------------ the skill
  const historyOf = (inst: Instrument, own: DailyBar[]): InstrumentHistory => ({
    instrument: inst,
    bars: own,
    indexSymbol: index.indexSymbol,
    indexBars: index.indexBars,
    volIndexSymbol: index.volIndexSymbol,
    volIndexBars: index.volIndexBars,
    statements: [],
    events: stored.get(inst.id) ?? ([] as CorporateEvent[]),
    ivPoints: [],
    chainAsOf: async () => null,
    fx: {},
    calibration: [],
    journal: [],
  });
  const ctxFor = (
    inst: Instrument,
    own: DailyBar[],
    priors: Map<string, SkillResult>,
    extras: Record<string, unknown>,
  ): SkillContext => ({
    instrument: inst,
    asOf,
    params,
    data: createDataAccess(historyOf(inst, own), asOf, {
      chainMaxAgeDays: params.runner.chainMaxAgeDays,
      priors,
      memo: new Map(),
    }),
    portfolio,
    conviction: null,
    maxCollateralPct: null,
    log: () => {},
    extras,
  });

  // the regime is a property of the market: one run, shared by every name
  const regimeSource = rows[0];
  const regimeResult = (await marketRegime.run(
    ctxFor(
      regimeSource ? regimeSource.s.instrument : stubInstrument(market),
      regimeSource ? regimeSource.bars : [],
      new Map(),
      {},
    ),
  )) as SkillResult<RegimePayload>;
  const regime = regimeResult.payload.regime;
  const posture: 'entries' | 'watch_only' = regime === 'panic' || regime === 'crash_guard' ? 'watch_only' : 'entries';

  const scored: { instrumentId: number; state: LeaderState; score: number; payload: LeadersPayload }[] = [];
  for (const r of candidates) {
    const inst = r.s.instrument;
    const extras: Record<string, unknown> = {
      [LEADERS_RANKS_KEY]: ranksOf.get(inst.id) ?? {
        rank1m: null,
        rank3m: null,
        rank6m: null,
        screened: eligible.length,
      },
    };
    const lk = looked.get(inst.id);
    if (lk) extras[LEADERS_EARNINGS_KEY] = lk;
    const priors = new Map<string, SkillResult>([['market.regime', regimeResult]]);
    try {
      const res = await leadersPullback.run(ctxFor(inst, r.bars, priors, extras));
      scored.push({ instrumentId: inst.id, state: res.payload.state, score: res.payload.score, payload: res.payload });
    } catch (err) {
      deps.log(`leaders: ${inst.symbol} failed: ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------------------- the market's own list and the funnel
  const listed = scored
    .filter((c) => c.state === 'setup' || c.state === 'watch')
    .sort(
      (a, b) =>
        (a.state === 'setup' ? 0 : 1) - (b.state === 'setup' ? 0 : 1) ||
        b.score - a.score ||
        a.instrumentId - b.instrumentId,
    )
    .slice(0, p.shortlistSize);
  const rankOf = new Map(listed.map((c, i) => [c.instrumentId, i + 1]));
  const rowsOut: NewCandidate[] = scored.map((c) => ({
    instrumentId: c.instrumentId,
    rank: rankOf.get(c.instrumentId) ?? null,
    state: c.state,
    score: c.score,
    payload: c.payload,
  }));
  await insertCandidates(db, runId, rowsOut);

  const consolidating = scored.filter(
    (c) => c.state === 'setup' || c.state === 'watch' || c.state === 'extended',
  ).length;
  const setups = scored.filter((c) => c.state === 'setup').length;
  const watches = scored.filter((c) => c.state === 'watch').length;
  const coverage = { withBar: withAsOfBar.length, names: withBars.length };
  const status: 'ok' | 'partial' = coverage.names > 0 && coverage.withBar / coverage.names < 0.8 ? 'partial' : 'ok';
  const notes: string[] = [];
  if (status === 'partial')
    notes.push(`only ${coverage.withBar} of ${coverage.names} names have a bar for ${asOf}: the data is thin`);
  if (eligible.length < 50) notes.push(`only ${eligible.length} names passed the screen: the ranks are coarse`);
  const durationMs = Math.round(performance.now() - o.t0);
  await finishRun(db, runId, {
    status,
    finishedAt: deps.now(),
    screened: eligible.length,
    leaders: leaders.length,
    consolidating,
    shortlisted: listed.length,
    regime,
    posture,
    detail: {
      funnel: {
        screened: eligible.length,
        leaders: leaders.length,
        consolidating,
        shortlisted: listed.length,
        setup: setups,
        watch: watches,
      },
      coverage,
      names: scanned.length,
      muted: screenSet.length - scanned.length,
      regimeInfo: {
        regime,
        volIndex: regimeResult.payload.volIndex,
        indexSymbol: regimeResult.payload.indexSymbol,
        volIndexSymbol: regimeResult.payload.volIndexSymbol,
        indexVsSma200Pct: regimeResult.payload.indexVsSma200Pct,
        usedVolIndex: regimeResult.payload.usedVolIndex,
      },
      notes,
      durationMs,
    },
  });
  const stamped = await stampOutcomes(db, market);
  deps.log(
    `leaders ${market} ${asOf}: ${scanned.length} names, ${eligible.length} screened, ${leaders.length} leaders, ${consolidating} consolidating, ${listed.length} listed (${setups} setup, ${watches} watch), ${stamped} outcomes stamped, ${durationMs} ms`,
  );
  return {
    runId,
    market,
    asOf,
    status,
    names: scanned.length,
    screened: eligible.length,
    leaders: leaders.length,
    consolidating,
    shortlisted: listed.length,
    setups,
    watches,
    regime,
    posture,
    coverage,
    durationMs,
    outcomesStamped: stamped,
  };
}

/**
 * Stamps what happened to earlier Setups of a market from the bars that arrived after the day each was shown (counted from
 * that close, not a backtest). Rows whose outcome is final are left alone. Returns the number of rows written.
 */
export async function stampOutcomes(db: Db, market: Market): Promise<number> {
  const waiting = await candidatesAwaitingOutcome(db, market);
  if (waiting.length === 0) return 0;
  const first = waiting.reduce((m, w) => (w.asOf < m ? w.asOf : m), waiting[0]?.asOf as ISODate);
  const bars = await loadBarsMany(db, [...new Set(waiting.map((w) => w.instrumentId))], first);
  let written = 0;
  for (const w of waiting) {
    const after = (bars.get(w.instrumentId) ?? []).filter((b) => b.day > w.asOf);
    const outcome = computeOutcome({ entry: w.entry, stop: w.stop }, after);
    if (!outcome) continue;
    await writeOutcome(db, w.id, outcome);
    written++;
  }
  return written;
}
