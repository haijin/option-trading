/**
 * Mock of the Leaders endpoints (src/server/api-types.ts, leaders section) with the sample data of
 * docs/prototypes/leaders-pullback.html. Everything the page needs is computed here the way the server will: deterministic
 * synthetic bars per name (run-up, base, turn-up), then EMA 21 / 50, AVWAP, the support map, the stop-first plan and the
 * flags from them. "Today" is the sample day (Tue 13 Oct 2026), not the real clock.
 *
 * State lives in memory: mute and undo, the watchlist button, and a refresh that takes a few seconds (status.refreshing).
 * Equity follows the Settings mock (store.equity): with none set the plan shows no share counts.
 *
 *   MOCK_LEADERS=empty        no scan has run yet (until Refresh finishes), to see the empty state
 *   MOCK_LEADERS=watch_only   panic regime: every Setup is shown as Watch and the header turns amber
 *   MOCK_LEADERS=stale        the newest run is old: the stale banner
 *   MOCK_LEADERS=brief        a model lead and a few one-line notes (stage L4)
 *   (comma-separate to combine)
 */
import type {
  Currency,
  LeaderBaseView,
  LeaderCandidateView,
  LeaderFlagView,
  LeaderLevelView,
  LeaderMuteView,
  LeaderOutcomeView,
  LeaderPlanView,
  LeaderRecordView,
  LeaderRunView,
  LeaderStage,
  LeaderState,
  LeadersCardView,
  LeadersDaysView,
  LeadersRefreshView,
  LeadersView,
  LeaderWatchView,
  Market,
} from '../../src/server/api-types';
import {
  BELOW_CUT,
  DROPPED_ARCHIVE,
  DROPPED_TODAY,
  LEADERS_ONLY,
  type LeaderSample,
  MODEL_BRIEF,
  RECORD,
  RUN_DAYS,
  SHORTLIST,
} from './leadersData';
import { store } from './state';
import { addDays, FX_USD_HKD, hash, invalid, isIsoDate, notFound, round, weekdaysEndingAt } from './util';
import { Body } from './validate';

const TODAY = RUN_DAYS[0].day;
const RISK_PCT = 0.005;
const STOP_BARS = 70;
const N = 160;

const flags = (): Set<string> =>
  new Set(
    (process.env.MOCK_LEADERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

// ------------------------------------------------------------------------------------------------ in-memory state
const mem = {
  muted: new Map<number, { days: number; until: string }>(),
  watched: new Set<number>(),
  /** Epoch ms until which a refresh is "running". */
  refreshingUntil: 0,
  /** A refresh has finished since the server started: in `empty` mode this is what makes the first run appear. */
  refreshed: false,
  lastRunOverride: null as string | null,
};

// ------------------------------------------------------------------------------------------------ the universe
interface Entry {
  id: number;
  instrumentId: number;
  sample: LeaderSample;
  /** Which list it belongs to. */
  group: 'shortlist' | 'leaders' | 'below';
}

const ENTRIES: Entry[] = [
  ...SHORTLIST.map((sample, i): Entry => ({ id: i + 1, instrumentId: 1000 + i, sample, group: 'shortlist' })),
  ...LEADERS_ONLY.map((sample, i): Entry => ({ id: 101 + i, instrumentId: 1100 + i, sample, group: 'leaders' })),
  ...BELOW_CUT.map((sample, i): Entry => ({ id: 201 + i, instrumentId: 1200 + i, sample, group: 'below' })),
];

/** Whether the Leaders universe knows the name (a research run may start on it without a watchlist row). */
export const isLeaderName = (market: Market, symbol: string): boolean =>
  ENTRIES.some((e) => e.sample.mkt === market && e.sample.sym === symbol);

// ------------------------------------------------------------------------------------------------ synthetic bars
/** The prototype's generator, ported: the same seeds draw the same charts. */
function rng(seed: number): () => number {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

interface Bars {
  close: number[];
  high: number[];
  low: number[];
  vol: number[];
  anchor: number;
}

function series(c: LeaderSample): Bars {
  const len = c.len;
  const anchor = N - 1 - len;
  const rand = rng(c.seed);
  const H = 100;
  const L = H * (1 - c.depth);
  const start = H / (1 + c.r6 / 100 + 0.08);
  const close: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const vol: number[] = [];
  for (let i = 0; i < N; i++) {
    let v: number;
    if (i <= anchor) {
      const t = i / anchor;
      v = start * (H / start) ** t * (1 + 0.025 * Math.sin(t * 19) + (rand() - 0.5) * 0.03);
      if (i === anchor) v = H;
    } else {
      const t = (i - anchor) / len;
      const trough = Math.min(1, t / 0.7);
      v = H - (H - L) * trough * (1 - 0.35 * Math.max(0, t - 0.7)) + (rand() - 0.5) * H * 0.012;
    }
    close.push(v);
  }
  const isSetup = c.state === 'setup';
  if (isSetup) {
    close[N - 2] = L * 1.004;
    close[N - 1] = L * 1.03;
  } else {
    close[N - 2] = close[N - 3] * (1 + (rand() - 0.5) * 0.01);
    close[N - 1] = close[N - 2] * (1 + c.chg / 100);
  }
  const k = c.px / close[N - 1];
  for (let i = 0; i < N; i++) {
    close[i] *= k;
    const r = close[i] * (0.012 + rand() * 0.012);
    high.push(close[i] + r * (0.4 + rand() * 0.6));
    low.push(close[i] - r * (0.4 + rand() * 0.6));
    const base = i <= anchor ? 1.0 : 1.0 - 0.45 * Math.min(1, (i - anchor) / len);
    vol.push(base * (0.7 + rand() * 0.6));
  }
  if (isSetup) {
    const stopPct = c.stop ?? 2.5;
    low[N - 1] = Math.min(low[N - 1], close[N - 1] * (1 - stopPct / 100) + close[N - 1] * 0.0025);
    high[N - 1] = Math.max(high[N - 1], close[N - 1] * 1.004);
    vol[N - 1] *= 1.5;
  }
  return { close, high, low, vol, anchor };
}

function ema(xs: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e = 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    if (i < period - 1) {
      sum += xs[i];
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      sum += xs[i];
      e = sum / period;
    } else e = xs[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function avwap(b: Bars, from: number): (number | null)[] {
  const out: (number | null)[] = new Array(b.close.length).fill(null);
  let pv = 0;
  let vv = 0;
  for (let i = from; i < b.close.length; i++) {
    const tp = (b.high[i] + b.low[i] + b.close[i]) / 3;
    pv += tp * b.vol[i];
    vv += b.vol[i];
    out[i] = pv / vv;
  }
  return out;
}

interface Computed {
  bars: Bars;
  e9: (number | null)[];
  e21: (number | null)[];
  e50: (number | null)[];
  awHigh: (number | null)[];
  awLow: (number | null)[];
}

const CACHE = new Map<string, Computed>();
function computed(c: LeaderSample): Computed {
  const key = `${c.mkt}:${c.sym}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const bars = series(c);
  const window = bars.low.slice(bars.anchor, N - 1);
  const lowIdx = bars.anchor + window.indexOf(Math.min(...window));
  const out: Computed = {
    bars,
    e9: ema(bars.close, 9),
    e21: ema(bars.close, 21),
    e50: ema(bars.close, 50),
    awHigh: avwap(bars, bars.anchor),
    awLow: avwap(bars, lowIdx),
  };
  CACHE.set(key, out);
  return out;
}

// ------------------------------------------------------------------------------------------------ one candidate view
const ccyOf = (m: Market): Currency => (m === 'US' ? 'USD' : 'HKD');

function equityIn(cur: Currency): number | null {
  if (store.equity === null) return null;
  if (cur === store.baseCurrency) return store.equity;
  return store.baseCurrency === 'HKD' ? store.equity / FX_USD_HKD : store.equity * FX_USD_HKD;
}

interface Ctx {
  /** Bars before the latest one: 0 today, 1 for the previous session, ... */
  offset: number;
  day: string;
  rank: number | null;
  /** Panic or crash guard: a Setup shows as Watch. */
  watchOnly: boolean;
  /** Stamp the later outcome (an archived day). */
  outcome: boolean;
  score: number;
}

function planOf(c: LeaderSample, bars: Bars, idx: number, entry: number, stopPct: number): LeaderPlanView {
  const cur = ccyOf(c.mkt);
  const stop = round(entry * (1 - stopPct / 100), c.px < 10 ? 3 : 2);
  const r = entry - stop;
  const lot = c.mkt === 'HK' ? (c.lot ?? 100) : 1;
  const eq = equityIn(cur);
  let riskBudget: number | null = null;
  let shares: number | null = null;
  let lotTooBig = false;
  let lotRiskPct: number | null = null;
  if (eq !== null) {
    riskBudget = round(eq * RISK_PCT, 2);
    shares = Math.floor(riskBudget / r);
    if (c.mkt === 'HK') shares = Math.floor(shares / lot) * lot;
    if (shares === 0) {
      shares = lot;
      lotTooBig = true;
    }
    lotRiskPct = round(((lot * r) / eq) * 100, 2);
  }
  const positionValue = shares === null ? null : round(shares * entry, 2);
  return {
    entry,
    altEntry: round(bars.high[idx] * 1.001, c.px < 10 ? 3 : 2),
    stop,
    stopPct,
    r: round(r, 4),
    riskBudget,
    shares,
    riskAtStop: shares === null ? null : round(shares * r, 2),
    positionValue,
    pctOfEquity: positionValue !== null && eq !== null ? round((positionValue / eq) * 100, 2) : null,
    r3: round(entry + 3 * r, c.px < 10 ? 3 : 2),
    r5: round(entry + 5 * r, c.px < 10 ? 3 : 2),
    lot,
    lotAssumed: c.lotAssumed === true,
    lotTooBig,
    lotRiskPct,
  };
}

function levelsOf(c: LeaderSample, cp: Computed, idx: number, px: number): LeaderLevelView[] {
  const { bars } = cp;
  const baseLow = Math.min(...bars.low.slice(bars.anchor, Math.max(bars.anchor + 1, idx - 1)));
  const raw: { source: string; label: string; v: number }[] = [
    { source: 'ema9', label: 'EMA 9', v: cp.e9[idx] ?? px },
    { source: 'ema21', label: 'EMA 21', v: cp.e21[idx] ?? px },
    { source: 'ema50', label: 'EMA 50', v: cp.e50[idx] ?? px },
    { source: 'avwap_high', label: 'AVWAP from range high', v: cp.awHigh[idx] ?? px },
    { source: 'avwap_low', label: 'AVWAP from base low', v: cp.awLow[idx] ?? px },
    { source: 'base_low', label: 'Base low', v: baseLow },
  ];
  if (c.sym === '1810') raw.push({ source: 'gap', label: 'Unfilled gap 22 Sep (top)', v: px * 0.979 });
  if (c.sym === 'APP') raw.push({ source: 'swing_high', label: 'Prior swing high 18 Aug', v: px * 0.992 });
  if (c.sym === 'TSM') raw.push({ source: 'gap', label: 'Unfilled gap 29 Sep (top)', v: px * 0.962 });
  const low3 = Math.min(bars.low[idx], bars.low[idx - 1], bars.low[idx - 2]);
  const gapOf = (v: number): number => Math.abs(low3 / v - 1);
  const near = raw.filter((l) => l.v <= px * 1.005 && gapOf(l.v) < 0.03).sort((a, b) => gapOf(a.v) - gapOf(b.v))[0];
  return raw.map((l) => ({
    source: l.source,
    label: l.label,
    level: round(l.v, px < 10 ? 3 : 2),
    distPct: round((px / l.v - 1) * 100, 2),
    inPlay: l === near,
  }));
}

function flagsOf(c: LeaderSample, plan: LeaderPlanView | null, earn: number | null): LeaderFlagView[] {
  const out: LeaderFlagView[] = [];
  if (earn !== null && earn <= 7) out.push({ level: 'fail', text: `Earnings in ${earn} d · blackout` });
  else if (earn !== null && earn <= 14) out.push({ level: 'warn', text: `Earnings in ${earn} d` });
  else if (earn === null) out.push({ level: 'warn', text: 'Earnings date unknown' });
  if (c.stop !== null && c.stop > 3) out.push({ level: 'fail', text: `Stop ${c.stop}% > 3% cap` });
  else if (c.stop !== null && c.stop >= 2.5) out.push({ level: 'warn', text: `Stop ${c.stop}% wide` });
  if (plan?.lotTooBig) out.push({ level: 'warn', text: `1 lot risks ${(plan.lotRiskPct ?? 0).toFixed(2)}%` });
  if (c.depth >= 0.2) out.push({ level: 'warn', text: `Base ${Math.round(c.depth * 100)}% deep` });
  return out;
}

function outcomeOf(c: LeaderSample, day: string, setup: boolean): LeaderOutcomeView {
  const h = hash(`${day}:${c.sym}`);
  const roll = h % 5;
  const wiggle = (n: number): number => round(((((h >>> n) % 1000) / 1000) * 14 - 4) * (c.mkt === 'HK' ? 0.8 : 1), 1);
  const hit = setup && roll <= 1;
  const stopped = setup && (roll === 2 || roll === 3);
  return {
    fwd5Pct: wiggle(3),
    fwd10Pct: wiggle(7),
    fwd20Pct: wiggle(11),
    hit3r: setup ? hit : null,
    stopped: setup ? stopped : null,
    maxR: setup
      ? hit
        ? round(3 + (h % 40) / 10, 1)
        : stopped
          ? round(0.3 + (h % 9) / 10, 1)
          : round((h % 25) / 10, 1)
      : null,
    daysTo3r: hit ? 3 + (h % 12) : null,
    asOf: TODAY,
  };
}

function toView(e: Entry, ctx: Ctx): LeaderCandidateView {
  const c = e.sample;
  const cp = computed(c);
  const idx = N - 1 - ctx.offset;
  const cur = ccyOf(c.mkt);
  const px = ctx.offset === 0 ? c.px : round(cp.bars.close[idx], c.px < 10 ? 3 : 2);
  const prev = cp.bars.close[idx - 1];
  const chg = ctx.offset === 0 ? c.chg : round((cp.bars.close[idx] / prev - 1) * 100, 2);
  const isSetup = c.state === 'setup' && !ctx.watchOnly;
  const st: LeaderState = c.state === 'setup' && ctx.watchOnly ? 'watch' : c.state;
  const earn = c.earn === null ? null : Math.max(0, c.earn - ctx.offset);
  const stopPct = c.stop;
  const plan = isSetup && stopPct !== null ? planOf(c, cp.bars, idx, px, stopPct) : null;
  const from = idx + 1 - STOP_BARS;
  const slice = (xs: readonly (number | null)[]): (number | null)[] =>
    xs.slice(from, idx + 1).map((v) => (v === null ? null : round(v, c.px < 10 ? 4 : 3)));
  const anchorIndex = cp.bars.anchor - from;
  const base: LeaderBaseView = {
    anchorDay: weekdaysEndingAt(ctx.day, c.len + 1 - ctx.offset)[0],
    depthRatio: c.depth,
    lenDays: c.len - ctx.offset > 0 ? c.len - ctx.offset : 1,
    contractionRatio: c.contr,
    volDryUpRatio: c.dry,
    atrRatio: c.atrR,
  };
  const reportsDone = store.runs.filter((r) => r.market === c.mkt && r.symbol === c.sym && r.status === 'done').length;
  const watched = c.watched === true || mem.watched.has(e.id);
  const reasonFlags = st === 'setup' || st === 'watch' ? flagsOf(c, plan, earn) : [];
  const shortlisted = e.group === 'shortlist';
  return {
    id: e.id,
    instrumentId: e.instrumentId,
    rank: ctx.rank,
    market: c.mkt,
    symbol: c.sym,
    name: c.name,
    currency: cur,
    state: st,
    isNew: ctx.offset === 0 && c.isNew === true && shortlisted,
    watched,
    hasChain: c.put !== undefined,
    hasStatements: watched || c.statements === true,
    price: px,
    changePct: chg,
    score: ctx.score,
    ret1mPct: c.r1,
    ret3mPct: c.r3,
    ret6mPct: c.r6,
    rank1m: c.pct[0],
    rank3m: c.pct[1],
    rank6m: c.pct[2],
    dollarVol20: round(c.dv * 1_000_000, 0),
    atrPct: round(1.9 + (c.seed % 7) * 0.25, 2),
    distEma21Pct: round((px / (cp.e21[idx] ?? px) - 1) * 100, 2),
    distAvwapPct: round((px / (cp.awHigh[idx] ?? px) - 1) * 100, 2),
    base,
    stopPct,
    earningsInDays: earn,
    earningsKnown: earn !== null,
    why: c.why.map(([level, text]) => ({ level, text })),
    flags: reasonFlags,
    brief: flags().has('brief') && ctx.offset === 0 ? (MODEL_BRIEF.lines[c.sym] ?? null) : null,
    plan,
    levels: shortlisted || e.group === 'below' ? levelsOf(c, cp, idx, px) : [],
    put:
      c.put !== undefined && shortlisted
        ? {
            expiry: c.put.expiry,
            strike: c.put.strike,
            delta: c.put.delta,
            rocPct: c.put.rocPct,
            belowStopPct: isSetup ? c.put.belowStopPct : null,
          }
        : null,
    spark: {
      closes: slice(cp.bars.close).map((v) => v as number),
      ema21: slice(cp.e21),
      ema50: slice(cp.e50),
      avwap: slice(cp.awHigh),
      stop: plan ? plan.stop : null,
      anchorIndex: anchorIndex >= 0 ? anchorIndex : null,
    },
    researchReports: reportsDone,
    reason: c.reason ?? null,
    outcome: ctx.outcome && shortlisted ? outcomeOf(c, ctx.day, isSetup) : null,
  };
}

// ------------------------------------------------------------------------------------------------ the day's list
function runDay(day: string): { day: string; offset: number } | undefined {
  return RUN_DAYS.find((d) => d.day === day);
}

/** The twenty (or fewer, on an archived day) of a day, ranked by their score of that day. */
function shortlistOf(day: string): { e: Entry; score: number }[] {
  const run = runDay(day);
  if (!run) return [];
  return ENTRIES.filter((e) => e.group === 'shortlist')
    .filter((e) => run.offset === 0 || hash(`${day}:${e.sample.sym}`) % 8 !== 0)
    .map((e) => ({
      e,
      score:
        run.offset === 0
          ? e.sample.score
          : Math.max(40, Math.min(97, e.sample.score + ((hash(`${day}/${e.sample.sym}`) % 9) - 4))),
    }))
    .sort((a, b) => b.score - a.score);
}

const isMuted = (id: number): boolean => mem.muted.has(id);

function runView(market: Market, day: string, lastRunAt: string): LeaderRunView {
  const us = market === 'US';
  const list = shortlistOf(day).filter((x) => x.e.sample.mkt === market);
  return {
    id: us ? 11 : 12,
    market,
    asOf: day,
    startedAt: new Date(Date.parse(lastRunAt) - (us ? 240_000 : 300_000)).toISOString(),
    finishedAt: lastRunAt,
    status: 'ok',
    screened: us ? 842 : 470,
    leaders: us ? 34 : 27,
    consolidating: us ? 15 : 14,
    shortlisted: list.length,
    regime: flags().has('watch_only') ? 'panic' : 'bull_calm',
    posture: flags().has('watch_only') ? 'watch_only' : 'entries',
    coverage: { withBar: us ? 839 : 466, names: us ? 842 : 470 },
  };
}

const STALE_AT = '2026-10-09T22:45:00.000Z';
const HK_RUN_AT = '2026-10-13T10:45:00.000Z';
const US_RUN_AT = '2026-10-13T22:45:00.000Z';

const noRunYet = (): boolean => flags().has('empty') && !mem.refreshed;

function status(): LeadersView['status'] {
  const stale = flags().has('stale') && !mem.refreshed;
  return {
    refreshing: Date.now() < mem.refreshingUntil,
    lastRunAt: noRunYet() ? null : (mem.lastRunOverride ?? (stale ? STALE_AT : US_RUN_AT)),
    stale,
    equityMissing: store.equity === null,
    ai: { available: true, auto: false, model: MODEL_BRIEF.model },
  };
}

function emptyView(): LeadersView {
  return {
    asOf: null,
    today: null,
    isArchive: false,
    prevDay: null,
    nextDay: null,
    runs: { US: null, HK: null },
    regime: null,
    funnel: {
      screened: { total: 0, US: 0, HK: 0 },
      leaders: 0,
      consolidating: 0,
      shortlist: 0,
      setup: 0,
      watch: 0,
      newToday: 0,
      dropped: 0,
      shortlistByMarket: { US: 0, HK: 0 },
    },
    stage: 'shortlist',
    stageNote: null,
    candidates: [],
    dropped: [],
    brief: null,
    status: status(),
  };
}

const STAGES: LeaderStage[] = ['screened', 'leaders', 'consolidating', 'shortlist'];

export function buildLeaders(query: URLSearchParams): LeadersView {
  const dateParam = query.get('date');
  const stageParam = query.get('stage') ?? 'shortlist';
  const marketParam = query.get('market');
  const stateParam = query.get('state');
  if (!(STAGES as string[]).includes(stageParam))
    throw invalid(`Query parameter "stage" must be one of ${STAGES.join(', ')}.`);
  if (marketParam !== null && marketParam !== 'all' && marketParam !== 'US' && marketParam !== 'HK')
    throw invalid('Query parameter "market" must be all, US or HK.');
  if (stateParam !== null && !['setup', 'watch', 'all'].includes(stateParam))
    throw invalid('Query parameter "state" must be setup, watch or all.');
  if (dateParam !== null && !isIsoDate(dateParam)) throw invalid('Query parameter "date" must be a YYYY-MM-DD date.');
  if (noRunYet()) return emptyView();

  const stage = stageParam as LeaderStage;
  const day = dateParam ?? TODAY;
  const run = runDay(day);
  if (!run) throw notFound(`No Leaders run is stored for ${day}.`);
  const isArchive = run.offset > 0;
  const watchOnly = flags().has('watch_only');
  const days = RUN_DAYS.map((d) => d.day);
  const at = days.indexOf(day);

  const shortlist = shortlistOf(day);
  const visible = shortlist.filter((x) => !isMuted(x.e.id));
  const ranked = visible.map((x, i) =>
    toView(x.e, { offset: run.offset, day, rank: i + 1, watchOnly, outcome: isArchive, score: x.score }),
  );
  const setupCount = ranked.filter((c) => c.state === 'setup').length;
  const mutedNow = shortlist.filter((x) => isMuted(x.e.id));

  let candidates: LeaderCandidateView[] = [];
  let stageNote: string | null = null;
  if (stage === 'shortlist') candidates = ranked;
  else if (stage === 'screened') {
    stageNote = 'Names that were not leaders are not stored: only the counts are kept.';
  } else if (isArchive) {
    stageNote = 'Names that stopped before the shortlist are only kept for the latest run.';
  } else {
    const pool =
      stage === 'leaders' ? ENTRIES.filter((e) => e.group === 'leaders') : ENTRIES.filter((e) => e.group === 'below');
    candidates = pool.map((e) =>
      toView(e, { offset: 0, day, rank: null, watchOnly, outcome: false, score: e.sample.score }),
    );
  }
  if (marketParam && marketParam !== 'all') candidates = candidates.filter((c) => c.market === marketParam);
  if (stateParam && stateParam !== 'all') candidates = candidates.filter((c) => c.state === stateParam);

  const droppedBase = (isArchive ? DROPPED_ARCHIVE : DROPPED_TODAY).map((d) => ({ ...d }));
  const droppedMuted = mutedNow.map((x) => {
    const m = mem.muted.get(x.e.id);
    return {
      instrumentId: x.e.instrumentId,
      market: x.e.sample.mkt,
      symbol: x.e.sample.sym,
      reason: `Muted by you on ${TODAY.slice(8)} Oct, ${m?.days ?? 10} trading days left`,
      muted: true,
    };
  });
  const dropped = [...droppedBase, ...(isArchive ? [] : droppedMuted)];

  const byMarket = (m: Market): number => ranked.filter((c) => c.market === m).length;
  const funnel = {
    screened: { total: 1312 - run.offset * 6, US: 842 - run.offset * 4, HK: 470 - run.offset * 2 },
    leaders: 61 - run.offset,
    consolidating: 29 - run.offset,
    shortlist: ranked.length,
    setup: setupCount,
    watch: ranked.length - setupCount,
    newToday: ranked.filter((c) => c.isNew).length,
    dropped: dropped.length,
    shortlistByMarket: { US: byMarket('US'), HK: byMarket('HK') },
  };
  const lastRunAt = status().lastRunAt ?? US_RUN_AT;
  const hkAt = flags().has('stale') && !mem.refreshed ? STALE_AT : HK_RUN_AT;
  return {
    asOf: day,
    today: TODAY,
    isArchive,
    prevDay: days[at + 1] ?? null,
    nextDay: days[at - 1] ?? null,
    runs: { US: runView('US', day, lastRunAt), HK: runView('HK', day, hkAt) },
    regime: watchOnly
      ? {
          label: 'Panic',
          line: 'Panic · VIX 38.4 · SPY and HSI below 200d',
          posture: 'watch_only',
          postureText: 'Watch only: pullback entries off',
        }
      : {
          label: 'Bull · calm',
          line: 'Bull · calm · VIX 17.2 · SPY and HSI above 200d',
          posture: 'entries',
          postureText: 'Entries allowed',
        },
    funnel,
    stage,
    stageNote,
    candidates,
    dropped,
    brief: flags().has('brief') && !isArchive ? { lead: MODEL_BRIEF.lead, model: MODEL_BRIEF.model } : null,
    status: status(),
  };
}

export function buildLeadersDays(query: URLSearchParams): LeadersDaysView {
  const month = query.get('month');
  if (month === null || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw invalid('Query parameter "month" must be YYYY-MM.');
  if (noRunYet()) return { month, days: [], today: null, earliest: null };
  const days = RUN_DAYS.filter((d) => d.day.startsWith(month)).map((d) => {
    const list = shortlistOf(d.day).filter((x) => !isMuted(x.e.id));
    const setups = flags().has('watch_only') ? 0 : list.filter((x) => x.e.sample.state === 'setup').length;
    return { day: d.day, setups, watch: list.length - setups };
  });
  return {
    month,
    days: days.sort((a, b) => a.day.localeCompare(b.day)),
    today: TODAY,
    earliest: RUN_DAYS[RUN_DAYS.length - 1].day,
  };
}

export function buildLeadersRecord(query: URLSearchParams): LeaderRecordView {
  const w = query.get('window') ?? '60';
  if (w !== '60' && w !== 'all') throw invalid('Query parameter "window" must be 60 or all.');
  if (noRunYet())
    return {
      window: w,
      setups: 0,
      hit3r: 0,
      stopped: 0,
      open: 0,
      avgR: null,
      medianDaysTo3r: null,
      best: null,
      worst: null,
      watchToSetup: { became: 0, of: 0 },
      since: null,
    };
  return RECORD[w];
}

/** The Leaders card of the overview; null until a scan has run. */
export function leadersCard(): LeadersCardView | null {
  if (noRunYet()) return null;
  const v = buildLeaders(new URLSearchParams());
  return {
    asOf: TODAY,
    setups: v.funnel.setup,
    newToday: v.funnel.newToday,
    shortlisted: v.funnel.shortlist,
    posture: v.regime?.posture ?? 'entries',
  };
}

// ------------------------------------------------------------------------------------------------ writes
export function refreshLeaders(): LeadersRefreshView {
  if (Date.now() < mem.refreshingUntil) return { queued: false, message: 'A scan is already running.' };
  mem.refreshingUntil = Date.now() + 4000;
  setTimeout(() => {
    mem.refreshed = true;
    mem.lastRunOverride = new Date().toISOString();
  }, 4000);
  return { queued: true, message: 'Scan queued for both markets: about 1 min warm.' };
}

function entryById(raw: string): Entry {
  const id = Number(raw);
  const found = Number.isInteger(id) ? ENTRIES.find((e) => e.id === id) : undefined;
  if (!found) throw notFound(`No Leaders candidate ${raw}.`);
  return found;
}

export function muteLeader(idRaw: string, raw: unknown): LeaderMuteView {
  const e = entryById(idRaw);
  const b = Body.from(raw);
  const days = b.optNumber('days', { min: 1, max: 60, int: true }) ?? 10;
  const reason = b.optString('reason') ?? 'Muted from the Leaders page';
  const until = addDays(TODAY, Math.ceil(days * 1.4));
  mem.muted.set(e.id, { days, until });
  return { days, until, reason };
}

export function unmuteLeader(idRaw: string): { ok: true } {
  const e = entryById(idRaw);
  mem.muted.delete(e.id);
  return { ok: true };
}

export function watchLeader(idRaw: string): LeaderWatchView {
  const e = entryById(idRaw);
  mem.watched.add(e.id);
  return { ok: true, market: e.sample.mkt, symbol: e.sample.sym };
}
