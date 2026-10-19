/**
 * The read side of the Leaders page (docs/designs/leaders-pullback.md): turns stored runs and candidates into the view the page
 * shows. Shared by the API server and by `pnpm cli leaders --json`, so both print the same shape. It never recomputes a skill:
 * an archived day renders the stored candidates, and the only arithmetic is unit conversion, the combined list of the two
 * markets, the funnel counts and the sparkline (indicators over stored bars).
 */
import { lastTradingDayOnOrBefore, type Market, prevTradingDay } from '../core/calendar';
import { addDays, type ISODate, startOfNextMonth } from '../core/dates';
import { type LeadersPayload, realizedR, selectShortlist } from '../core/leaders';
import type { Currency, DailyBar } from '../core/types';
import { median, round } from '../core/util';
import type { Db } from '../db/client';
import {
  activeMutes,
  type CandidateRow,
  instrumentFacts,
  latestRun,
  listCandidates,
  listedInstrumentIds,
  listedRowsSince,
  listWatchlistIds,
  loadBarsMany,
  type MuteRow,
  previousRun,
  type RunRow,
  runDays,
  setupCountsByDay,
} from '../db/leaders';
import { getInstrument, getSettings, loadParams } from '../db/repos';
import { ema } from '../indicators';
import { leadersAsOf } from '../jobs/leaders-scan';
import { putAngle } from './put';
import type {
  LeaderCandidateView,
  LeaderDroppedView,
  LeaderFunnelView,
  LeaderRecordExtreme,
  LeaderRecordView,
  LeaderRegimeView,
  LeaderRunView,
  LeaderSparkView,
  LeaderStage,
  LeadersCardView,
  LeadersDaysView,
  LeadersStatusView,
  LeadersView,
} from './types';

const SPARK_BARS = 70;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (d: ISODate): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? '?'}`;
const pct1 = (x: number | null): number | null => (x === null ? null : round(x * 100, 1));
const pct2 = (x: number | null): number | null => (x === null ? null : round(x * 100, 2));

export interface LeadersViewInput {
  now: Date;
  /** An archived day: renders the stored runs of exactly that date. Absent: the newest run of each market. */
  date?: ISODate;
  stage?: LeaderStage;
  refreshing?: boolean;
  ai?: { available: boolean; auto: boolean; model: string };
}

const REGIME_LABEL: Record<string, string> = {
  bull_calm: 'Bull · calm',
  bull_volatile: 'Bull · volatile',
  bear_calm: 'Bear · calm',
  panic: 'Panic',
  crash_guard: 'Crash guard',
};

interface RegimeInfo {
  regime: string | null;
  volIndex: number | null;
  indexSymbol: string | null;
  volIndexSymbol: string | null;
  indexVsSma200Pct: number | null;
}

const regimeInfoOf = (run: RunRow): RegimeInfo | null =>
  ((run.detail as { regimeInfo?: RegimeInfo }).regimeInfo as RegimeInfo | undefined) ?? null;

function runView(run: RunRow): LeaderRunView {
  const d = run.detail as { coverage?: { withBar: number; names: number } };
  return {
    id: run.id,
    market: run.market,
    asOf: run.asOf,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    status: run.status as LeaderRunView['status'],
    screened: run.screened,
    leaders: run.leaders,
    consolidating: run.consolidating,
    shortlisted: run.shortlisted,
    regime: run.regime,
    posture: run.posture as 'entries' | 'watch_only',
    coverage: d.coverage ?? null,
  };
}

/** "Bull · calm · VIX 17.2 · SPY and HSI above 200d", and what the regime allows. */
export function regimeView(runs: Partial<Record<Market, RunRow>>): LeaderRegimeView | null {
  const present = (['US', 'HK'] as Market[]).flatMap((m) => {
    const r = runs[m];
    return r ? [{ market: m, run: r, info: regimeInfoOf(r) }] : [];
  });
  if (present.length === 0) return null;
  const labels = present.map((p) => REGIME_LABEL[p.run.regime ?? ''] ?? 'Regime unknown');
  const label =
    new Set(labels).size === 1 ? (labels[0] as string) : present.map((p, i) => `${p.market} ${labels[i]}`).join(' / ');
  const bits: string[] = [label];
  for (const p of present) {
    if (p.info?.volIndex !== null && p.info?.volIndex !== undefined)
      bits.push(`${p.info.volIndexSymbol ?? 'Vol'} ${p.info.volIndex.toFixed(1)}`);
  }
  const above = present
    .filter((p) => p.info && p.info.indexVsSma200Pct !== null && p.info.indexSymbol)
    .map((p) => ({ sym: p.info?.indexSymbol as string, up: (p.info?.indexVsSma200Pct as number) >= 0 }));
  const ups = above.filter((a) => a.up).map((a) => a.sym);
  const downs = above.filter((a) => !a.up).map((a) => a.sym);
  const join = (xs: string[]): string => (xs.length === 2 ? `${xs[0]} and ${xs[1]}` : xs.join(', '));
  if (ups.length > 0) bits.push(`${join(ups)} above 200d`);
  if (downs.length > 0) bits.push(`${join(downs)} below 200d`);
  const watchOnly = present.filter((p) => p.run.posture === 'watch_only');
  const posture: 'entries' | 'watch_only' = watchOnly.length === present.length ? 'watch_only' : 'entries';
  const postureText =
    watchOnly.length === 0
      ? 'Entries allowed'
      : watchOnly.length === present.length
        ? 'Watch only: pullback entries off'
        : `Entries allowed (${present
            .filter((p) => p.run.posture !== 'watch_only')
            .map((p) => p.market)
            .join(', ')}); watch only in ${watchOnly.map((p) => p.market).join(', ')}`;
  return { label, line: bits.join(' · '), posture, postureText };
}

// ----------------------------------------------------------------------------------------------- the sparkline
export function sparkOf(bars: readonly DailyBar[], payload: LeadersPayload): LeaderSparkView {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const from = Math.max(0, n - SPARK_BARS);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const anchorDay = payload.base?.anchorDay ?? null;
  const anchorIdx = anchorDay ? bars.findIndex((b) => b.day === anchorDay) : -1;
  const aw: (number | null)[] = new Array<number | null>(n).fill(null);
  if (anchorIdx >= 0) {
    let pv = 0;
    let vv = 0;
    for (let i = anchorIdx; i < n; i++) {
      const b = bars[i] as DailyBar;
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vv += b.volume;
      aw[i] = vv > 0 ? round(pv / vv, 4) : null;
    }
  }
  const slice = (xs: readonly (number | null)[]): (number | null)[] =>
    xs.slice(from).map((x) => (x === null || x === undefined ? null : round(x, 4)));
  return {
    closes: closes.slice(from).map((c) => round(c, 4)),
    ema21: slice(e21),
    ema50: slice(e50),
    avwap: slice(aw),
    stop: payload.plan ? payload.plan.stop : null,
    anchorIndex: anchorIdx >= from ? anchorIdx - from : null,
  };
}

// ------------------------------------------------------------------------------------------ one candidate card
interface Facts {
  watched: Set<number>;
  statements: Set<number>;
  chains: Set<number>;
  reports: Map<number, number>;
}

export function candidateView(
  row: CandidateRow,
  o: { rank: number | null; isNew: boolean; bars: readonly DailyBar[]; facts: Facts },
): LeaderCandidateView {
  const p = row.payload;
  const plan = p.plan;
  const hasOutcome = row.hit3r !== null || row.fwd5 !== null || row.outcomeAsOf !== null;
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    rank: o.rank,
    market: row.market,
    symbol: row.symbol,
    name: row.name,
    currency: row.currency as Currency,
    state: row.state,
    isNew: o.isNew,
    watched: o.facts.watched.has(row.instrumentId),
    hasChain: o.facts.chains.has(row.instrumentId),
    hasStatements: o.facts.statements.has(row.instrumentId),
    price: p.close,
    changePct: pct2(p.changePct),
    score: row.score,
    ret1mPct: pct1(p.ret1m),
    ret3mPct: pct1(p.ret3m),
    ret6mPct: pct1(p.ret6m),
    rank1m: p.rank1m === null ? null : Math.round(p.rank1m),
    rank3m: p.rank3m === null ? null : Math.round(p.rank3m),
    rank6m: p.rank6m === null ? null : Math.round(p.rank6m),
    dollarVol20: p.dollarVol20,
    atrPct: pct2(p.atrPct),
    distEma21Pct: pct2(p.distEma21),
    distAvwapPct: pct2(p.distAvwapHigh),
    base: p.base
      ? {
          anchorDay: p.base.anchorDay,
          depthRatio: p.base.depth,
          lenDays: p.base.len,
          contractionRatio: p.base.contraction,
          volDryUpRatio: p.base.volDryUp,
          atrRatio: p.base.atrRatio,
        }
      : null,
    stopPct: pct2(p.stopPct),
    earningsInDays: p.earningsInDays,
    earningsKnown: p.earningsKnown,
    why: p.why,
    flags: [
      ...p.flags,
      ...(o.facts.watched.has(row.instrumentId) ? [{ level: 'ok' as const, text: 'On watchlist' }] : []),
      ...(o.facts.chains.has(row.instrumentId) ? [{ level: 'ok' as const, text: 'Chain stored' }] : []),
    ],
    brief: row.briefLine,
    plan: plan
      ? {
          entry: plan.entry,
          altEntry: plan.altEntry,
          stop: plan.stop,
          stopPct: pct2(plan.stopPct) as number,
          r: plan.r,
          riskBudget: plan.riskBudget,
          shares: plan.shares,
          riskAtStop: plan.riskAtStop,
          positionValue: plan.positionValue,
          pctOfEquity: pct1(plan.pctOfEquity),
          r3: plan.r3,
          r5: plan.r5,
          lot: plan.lot,
          lotAssumed: p.flags.some((f) => f.text === 'Board lot unverified'),
          lotTooBig: plan.lotTooBig,
          lotRiskPct: pct2(plan.lotRiskPct),
        }
      : null,
    levels: p.levels.map((l) => ({
      source: l.source,
      label: l.label,
      level: l.level,
      distPct: pct2(l.distPct) as number,
      inPlay: l.inPlay,
    })),
    put: null,
    spark: sparkOf(o.bars, p),
    researchReports: o.facts.reports.get(row.instrumentId) ?? 0,
    quality: null,
    reason: p.reason,
    outcome: hasOutcome
      ? {
          fwd5Pct: pct2(row.fwd5),
          fwd10Pct: pct2(row.fwd10),
          fwd20Pct: pct2(row.fwd20),
          hit3r: row.hit3r,
          stopped: row.stopped,
          maxR: row.maxR,
          daysTo3r: row.daysTo3r,
          asOf: row.outcomeAsOf,
        }
      : null,
  };
}

// ----------------------------------------------------------------------------------------------- the whole page
const ZERO_FUNNEL: LeaderFunnelView = {
  screened: { total: 0, US: 0, HK: 0 },
  leaders: 0,
  consolidating: 0,
  shortlist: 0,
  setup: 0,
  watch: 0,
  newToday: 0,
  dropped: 0,
  shortlistByMarket: { US: 0, HK: 0 },
};

const STAGE_NOTES: Partial<Record<LeaderStage, string>> = {
  screened:
    'Names that were screened but were not leaders are counted, not stored: they never reached the base test, so there is no rule to list.',
};

/** The reason a name left the list, in words, from today's row (or the lack of one) and the mutes in force. */
function droppedReason(
  row: CandidateRow | undefined,
  mute: MuteRow | undefined,
  size: number,
  asOf: ISODate,
  market: Market,
): { reason: string; muted: boolean } {
  if (mute) {
    const left = countTradingDays(market, asOf, mute.until);
    return {
      reason: `Muted by you on ${dayName(mute.createdAt.toISOString().slice(0, 10))}, ${left} trading day${left === 1 ? '' : 's'} left`,
      muted: true,
    };
  }
  if (!row) return { reason: 'No bars for this day, or it left the universe', muted: false };
  const text = row.payload.reason;
  if (row.state === 'extended' || row.state === 'broken' || row.state === 'excluded')
    return { reason: text ? text.charAt(0).toUpperCase() + text.slice(1) : `Now ${row.state}`, muted: false };
  if (row.rank === null) return { reason: `Below the top ${size} today`, muted: false };
  return { reason: 'Moved within the list', muted: false };
}

function countTradingDays(market: Market, from: ISODate, to: ISODate): number {
  let n = 0;
  let d = from;
  while (d < to && n < 60) {
    d = addDays(d, 1);
    try {
      if (lastTradingDayOnOrBefore(market, d) === d) n++;
    } catch {
      n++;
    }
  }
  return n;
}

export async function buildLeadersView(db: Db, q: LeadersViewInput): Promise<LeadersView> {
  const loaded = await loadParams(db);
  const p = loaded.params['leaders.pullback'];
  const days = await runDays(db);
  const lastDay = days[days.length - 1] ?? null;
  const settings = await getSettings(db);
  const stage: LeaderStage = q.stage ?? 'shortlist';
  const markets: Market[] = ['US', 'HK'];

  // the runs of the day shown
  const runs: Partial<Record<Market, RunRow>> = {};
  for (const m of markets) {
    const r = await latestRun(db, m, q.date ?? null);
    if (r && (q.date === undefined || r.asOf === q.date)) runs[m] = r;
  }
  const shown = markets.flatMap((m) => (runs[m] ? [runs[m] as RunRow] : []));
  const asOf = shown.length > 0 ? (shown.map((r) => r.asOf).sort()[shown.length - 1] ?? null) : (q.date ?? null);
  const status = (): LeadersStatusView => {
    const finished = shown.map((r) => r.finishedAt).filter((d): d is Date => d !== null);
    const newest = finished.length > 0 ? new Date(Math.max(...finished.map((d) => d.getTime()))) : null;
    let stale = shown.length === 0;
    for (const r of shown) {
      try {
        const expected = leadersAsOf(r.market, q.now);
        if (r.asOf < prevTradingDay(r.market, expected)) stale = true;
      } catch {
        // outside the calendar tables: no claim either way
      }
    }
    return {
      refreshing: q.refreshing ?? false,
      lastRunAt: newest ? newest.toISOString() : null,
      stale: q.date === undefined ? stale : false,
      equityMissing: settings.equity === null,
      ai: q.ai ?? { available: false, auto: false, model: '' },
    };
  };
  const empty: LeadersView = {
    asOf,
    today: lastDay,
    isArchive: false,
    prevDay: null,
    nextDay: null,
    runs: { US: null, HK: null },
    regime: null,
    funnel: ZERO_FUNNEL,
    stage,
    stageNote: null,
    candidates: [],
    dropped: [],
    brief: null,
    status: status(),
  };
  if (shown.length === 0) return { ...empty, isArchive: q.date !== undefined };

  const rows = await listCandidates(
    db,
    shown.map((r) => r.id),
  );
  // the combined list: each market's own list merged, Setup first, with the per-market floor
  const listedRows = rows.filter((r) => r.rank !== null);
  const combinedIds = selectShortlist(
    listedRows.map((r) => ({ id: r.id, market: r.market, state: r.state, score: r.score })),
    p.shortlistSize,
    p.marketFloor,
  );
  const combinedRank = new Map(combinedIds.map((id, i) => [id, i + 1]));
  const combined = combinedIds.map((id) => rows.find((r) => r.id === id) as CandidateRow);

  // what was on the previous list (NEW badge and the dropped row), per market
  const prevListed = new Map<Market, Set<number>>();
  const prevRuns = new Map<Market, RunRow>();
  for (const r of shown) {
    const prev = await previousRun(db, r.market, r.asOf);
    if (prev) {
      prevRuns.set(r.market, prev);
      prevListed.set(r.market, new Set(await listedInstrumentIds(db, prev.id)));
    }
  }
  const wasListed = (row: CandidateRow): boolean => prevListed.get(row.market)?.has(row.instrumentId) ?? false;
  const mutes = await activeMutes(db, asOf ?? q.now.toISOString().slice(0, 10));
  const currentByInstrument = new Map(rows.map((r) => [r.instrumentId, r]));
  const dropped: LeaderDroppedView[] = [];
  for (const m of markets) {
    const prev = prevListed.get(m);
    const run = runs[m];
    if (!prev || !run) continue;
    for (const id of prev) {
      const now = currentByInstrument.get(id);
      if (now && combinedRank.has(now.id)) continue;
      // names of the other market's combined list are not this market's concern; a name of this market that is still ranked
      // in its own list but cut by the combined cap is reported as below the top
      const inst = now?.instrument ?? (await instrumentRowOf(db, id));
      if (!inst) continue;
      const why = droppedReason(now, mutes.get(id), p.shortlistSize, run.asOf, m);
      dropped.push({ instrumentId: id, market: m, symbol: inst.symbol, reason: why.reason, muted: why.muted });
    }
  }
  dropped.sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));

  // which rows to print
  let listing: { row: CandidateRow; rank: number | null }[];
  if (stage === 'shortlist') listing = combined.map((row) => ({ row, rank: combinedRank.get(row.id) ?? null }));
  else if (stage === 'consolidating')
    listing = rows
      .filter((r) => (r.state === 'setup' || r.state === 'watch' || r.state === 'extended') && !combinedRank.has(r.id))
      .map((row) => ({ row, rank: null }));
  else if (stage === 'leaders')
    listing = rows
      .filter((r) => (r.state === 'excluded' || r.state === 'broken') && r.payload.isLeader)
      .map((row) => ({ row, rank: null }));
  else listing = [];

  const ids = listing.map((l) => l.row.instrumentId);
  const [facts, watchIds] = await Promise.all([instrumentFacts(db, ids), listWatchlistIds(db)]);
  const earliest = asOf ? addDays(asOf, -200) : '2000-01-01';
  const bars = await loadBarsMany(db, ids, earliest);
  const factsAll: Facts = {
    watched: watchIds,
    statements: facts.statements,
    chains: facts.chains,
    reports: facts.reports,
  };
  const candidates = listing.map(({ row, rank }) =>
    candidateView(row, {
      rank,
      isNew: stage === 'shortlist' && prevListed.has(row.market) && !wasListed(row),
      bars: (bars.get(row.instrumentId) ?? []).filter((b) => b.day <= row.asOf),
      facts: factsAll,
    }),
  );

  // the premium-collecting version of the thesis, for a followed name with a stored chain
  for (const c of candidates) {
    if (!c.watched || !c.hasChain || !asOf) continue;
    const row = listing.find((l) => l.row.instrumentId === c.instrumentId)?.row;
    const level = c.plan ? c.plan.stop : (row?.payload.inPlay?.level ?? null);
    if (level === null || level === undefined) continue;
    c.put = await putAngle(db, {
      instrumentId: c.instrumentId,
      market: c.market,
      asOf: row?.asOf ?? asOf,
      level,
      levelIsStop: c.plan !== null,
      params: loaded.params,
    }).catch(() => null);
  }

  const screened = { total: 0, US: 0, HK: 0 };
  let leaders = 0;
  let consolidating = 0;
  for (const r of shown) {
    screened[r.market] = r.screened;
    screened.total += r.screened;
    leaders += r.leaders;
    consolidating += r.consolidating;
  }
  const funnel: LeaderFunnelView = {
    screened,
    leaders,
    consolidating,
    shortlist: combined.length,
    setup: combined.filter((r) => r.state === 'setup').length,
    watch: combined.filter((r) => r.state === 'watch').length,
    newToday: combined.filter((r) => prevListed.has(r.market) && !wasListed(r)).length,
    dropped: dropped.length,
    shortlistByMarket: {
      US: combined.filter((r) => r.market === 'US').length,
      HK: combined.filter((r) => r.market === 'HK').length,
    },
  };

  const leads = shown.flatMap((r) =>
    r.briefLead ? [{ market: r.market, lead: r.briefLead, model: r.briefModel }] : [],
  );
  const dayIdx = asOf ? days.indexOf(asOf) : -1;
  return {
    asOf,
    today: lastDay,
    isArchive: q.date !== undefined && lastDay !== null && q.date < lastDay,
    prevDay: asOf ? ([...days].reverse().find((d) => d < asOf) ?? null) : null,
    nextDay: dayIdx >= 0 ? (days[dayIdx + 1] ?? null) : null,
    runs: { US: runs.US ? runView(runs.US) : null, HK: runs.HK ? runView(runs.HK) : null },
    regime: regimeView(runs),
    funnel,
    stage,
    stageNote: STAGE_NOTES[stage] ?? null,
    candidates,
    dropped,
    brief:
      leads.length === 0
        ? null
        : {
            lead:
              leads.length === 1
                ? (leads[0] as { lead: string }).lead
                : leads.map((l) => `${l.market}: ${l.lead}`).join(' '),
            model: leads[0]?.model ?? null,
          },
    status: status(),
  };
}

async function instrumentRowOf(db: Db, id: number): Promise<{ symbol: string } | null> {
  const i = await getInstrument(db, id);
  return i ? { symbol: i.symbol } : null;
}

// ------------------------------------------------------------------------------------------------- the calendar
export async function buildLeadersDays(db: Db, month: string): Promise<LeadersDaysView> {
  const first = `${month}-01`;
  const next = startOfNextMonth(first);
  const counts = await setupCountsByDay(db, first, next);
  const all = await runDays(db);
  return {
    month,
    days: counts,
    today: all[all.length - 1] ?? null,
    earliest: all[0] ?? null,
  };
}

// --------------------------------------------------------------------------------------------------- the record
export async function buildLeadersRecord(db: Db, window: '60' | 'all'): Promise<LeaderRecordView> {
  const all = await runDays(db);
  const from = window === 'all' || all.length === 0 ? null : (all[Math.max(0, all.length - 60)] as ISODate);
  const rows = await listedRowsSince(db, from);
  const setups = rows.filter((r) => r.state === 'setup' && r.payload.plan);
  const watches = rows.filter((r) => r.state === 'watch');
  const hit = setups.filter((r) => r.hit3r === true);
  const stopped = setups.filter((r) => r.stopped === true);
  const open = setups.filter((r) => r.hit3r !== true && r.stopped !== true && r.fwd20 === null);
  const rs = setups.flatMap((r) => {
    const plan = r.payload.plan;
    if (!plan) return [];
    const v = realizedR(plan, { hit3r: r.hit3r, stopped: r.stopped, maxR: r.maxR, fwd20: r.fwd20 });
    return v === null ? [] : [v];
  });
  const extreme = (r: CandidateRow, value: number): LeaderRecordExtreme => ({
    r: round(value, 2),
    symbol: r.symbol,
    day: r.asOf,
    note: value < -1.05 ? 'gap through the stop' : null,
  });
  const winners = hit.filter((r) => r.maxR !== null);
  const losers = stopped.filter((r) => r.maxR !== null);
  const best = winners.length > 0 ? winners.reduce((a, b) => ((b.maxR as number) > (a.maxR as number) ? b : a)) : null;
  const worst = losers.length > 0 ? losers.reduce((a, b) => ((b.maxR as number) < (a.maxR as number) ? b : a)) : null;
  // Watch rows that later printed a Setup within 30 days
  const setupsByInstrument = new Map<number, ISODate[]>();
  for (const r of rows.filter((x) => x.state === 'setup')) {
    const list = setupsByInstrument.get(r.instrumentId) ?? [];
    list.push(r.asOf);
    setupsByInstrument.set(r.instrumentId, list);
  }
  const became = watches.filter((w) =>
    (setupsByInstrument.get(w.instrumentId) ?? []).some((d) => d > w.asOf && d <= addDays(w.asOf, 30)),
  ).length;
  const daysTo3r = hit.flatMap((r) => (r.daysTo3r === null ? [] : [r.daysTo3r]));
  const med = median(daysTo3r);
  return {
    window,
    setups: setups.length,
    hit3r: hit.length,
    stopped: stopped.length,
    open: open.length,
    avgR: rs.length > 0 ? round(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
    medianDaysTo3r: med === null ? null : Math.round(med),
    best: best ? extreme(best, best.maxR as number) : null,
    worst: worst ? extreme(worst, worst.maxR as number) : null,
    watchToSetup: { became, of: watches.length },
    since: setups[0]?.asOf ?? null,
  };
}

/** The Leaders card on Today: how many Setups the latest lists hold and how many are new. */
export async function buildLeadersCard(db: Db, now: Date): Promise<LeadersCardView | null> {
  const view = await buildLeadersView(db, { now });
  if (!view.asOf || view.candidates.length === 0)
    return view.asOf
      ? { asOf: view.asOf, setups: 0, newToday: 0, shortlisted: 0, posture: view.regime?.posture ?? 'entries' }
      : null;
  return {
    asOf: view.asOf,
    setups: view.funnel.setup,
    newToday: view.funnel.newToday,
    shortlisted: view.funnel.shortlist,
    posture: view.regime?.posture ?? 'entries',
  };
}
