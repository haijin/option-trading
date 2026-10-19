/**
 * Shared vocabulary of the Leaders page and the `leaders.pullback` skill (docs/designs/leaders-pullback.md): the payload the
 * skill produces, and the small pure rules around it (percentile rank, the shortlist, the forward outcome of a Setup).
 * Pure: no clock, no database, no provider. Returns and distances are fractions (0.71 = +71%); rank percentiles are 0-100.
 */
import type { Market } from './calendar';
import type { ISODate } from './dates';

export type LeaderState = 'setup' | 'watch' | 'extended' | 'broken' | 'excluded';
/** The furthest funnel stage a name reached: screened (passed the history, price and liquidity rows), leaders, consolidating. */
export type LeaderReached = 'screened' | 'leaders' | 'consolidating';
export type LeaderPosture = 'entries' | 'watch_only';

export type LevelSource =
  | 'ema9'
  | 'ema21'
  | 'ema50'
  | 'swing_low'
  | 'swing_high'
  | 'gap'
  | 'avwap_high'
  | 'avwap_low'
  | 'base_low';

/** Two levels of the same family count once toward confluence. */
export type LevelFamily = 'ema' | 'swing' | 'gap' | 'avwap' | 'base';

export const LEVEL_FAMILY: Record<LevelSource, LevelFamily> = {
  ema9: 'ema',
  ema21: 'ema',
  ema50: 'ema',
  swing_low: 'swing',
  swing_high: 'swing',
  gap: 'gap',
  avwap_high: 'avwap',
  avwap_low: 'avwap',
  base_low: 'base',
};

export interface LeaderLevel {
  source: LevelSource;
  label: string;
  level: number;
  /** close / level - 1: positive = price is above the level. */
  distPct: number;
  inPlay: boolean;
}

export interface LeaderBase {
  anchorDay: ISODate;
  anchorHigh: number;
  baseLow: number;
  /** (H - L) / H. */
  depth: number;
  /** Bars since the anchor high. */
  len: number;
  /** 10-bar range / 20-bar range. */
  contraction: number | null;
  /** Mean volume of 10 bars / mean volume of 50 bars. */
  volDryUp: number | null;
  /** ATR now / ATR at the anchor high. */
  atrRatio: number | null;
}

export interface LeaderPlan {
  entry: number;
  /** Stop-buy one tick above today's high (the intraday alternative to the close). */
  altEntry: number;
  stop: number;
  stopPct: number;
  /** 1R in price: entry - stop. */
  r: number;
  /** In the name's currency; null while equity or the FX rate is missing. */
  riskBudget: number | null;
  shares: number | null;
  riskAtStop: number | null;
  positionValue: number | null;
  pctOfEquity: number | null;
  r3: number;
  r5: number;
  lot: number;
  /** One board lot already risks more than the budget; the plan still shows one lot. */
  lotTooBig: boolean;
  lotRiskPct: number | null;
}

export interface LeaderWhy {
  level: 'pass' | 'warn' | 'info';
  text: string;
}

export interface LeaderFlag {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface LeaderScoreParts {
  momentum: number;
  tightness: number;
  confluence: number;
  trigger: number;
  liquidity: number;
  penalty: number;
}

/** The full result of `leaders.pullback` for one name on one day (stored as leaders_candidates.payload). */
export interface LeadersPayload {
  state: LeaderState;
  reached: LeaderReached;
  /** The rule that decided a non-list state or a demotion, in words ("base 31% deep, limit 25%"). */
  reason: string | null;
  asOf: ISODate;
  close: number | null;
  prevClose: number | null;
  changePct: number | null;
  dollarVol20: number | null;
  bars: number;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  rank1m: number | null;
  rank3m: number | null;
  rank6m: number | null;
  isLeader: boolean;
  indexRet3m: number | null;
  /** ret3m minus the index's 3-month return. */
  rs3m: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  atr14: number | null;
  atrPct: number | null;
  avwapHigh: number | null;
  avwapLow: number | null;
  distEma21: number | null;
  distAvwapHigh: number | null;
  base: LeaderBase | null;
  levels: LeaderLevel[];
  inPlay: LeaderLevel | null;
  confluence: number;
  turnUp: boolean;
  /** Where today's close sits in today's range: 0 = the low, 1 = the high. */
  closePos: number | null;
  /** Width of the stop a turn-up bar today needs; set for a Setup and for a Watch whose bar was too wide. */
  stopPct: number | null;
  plan: LeaderPlan | null;
  earningsInDays: number | null;
  earningsKnown: boolean;
  exDividendInDays: number | null;
  regime: string | null;
  posture: LeaderPosture;
  score: number;
  parts: LeaderScoreParts;
  flags: LeaderFlag[];
  why: LeaderWhy[];
}

/** What a scan stores about its funnel (leaders_runs.detail.funnel). */
export interface LeaderFunnelCounts {
  screened: number;
  leaders: number;
  consolidating: number;
  shortlisted: number;
  setup: number;
  watch: number;
}

// ------------------------------------------------------------------------------------------------------- ranks
/**
 * Percentile of `x` among `sortedAsc` (ascending): the share of values below it plus half the share equal to it, 0-100.
 * `x` is expected to be one of the values. Empty input gives 0.
 */
export function percentRank(sortedAsc: readonly number[], x: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sortedAsc[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  const less = lo;
  hi = n;
  let up = lo;
  while (up < hi) {
    const mid = (up + hi) >>> 1;
    if ((sortedAsc[mid] as number) <= x) up = mid + 1;
    else hi = mid;
  }
  const equal = up - less;
  return (100 * (less + 0.5 * equal)) / n;
}

/** Bars back for the 1-, 3- and 6-month returns. */
export const RETURN_BARS = { m1: 21, m3: 63, m6: 126 } as const;

export function trailingReturn(closes: readonly number[], bars: number): number | null {
  const n = closes.length;
  if (n <= bars) return null;
  const base = closes[n - 1 - bars] as number;
  return base > 0 ? (closes[n - 1] as number) / base - 1 : null;
}

// ------------------------------------------------------------------------------------------------------ shortlist
export interface ShortlistItem {
  id: number;
  market: Market;
  state: LeaderState;
  score: number;
}

/**
 * The names on the list, in display order: Setup before Watch, then score. Only `setup` and `watch` are eligible; the list
 * holds at most `size` names, and a market that has `floor` or more eligible names gets at least `floor` of them (otherwise the
 * other market fills the places: padding a market with weak names is worse than an uneven split).
 */
export function selectShortlist(items: readonly ShortlistItem[], size: number, floor: number): number[] {
  const order = (a: ShortlistItem, b: ShortlistItem): number =>
    (a.state === 'setup' ? 0 : 1) - (b.state === 'setup' ? 0 : 1) || b.score - a.score || a.id - b.id;
  const eligible = items.filter((i) => i.state === 'setup' || i.state === 'watch').sort(order);
  const chosen = new Set<number>();
  for (const market of ['US', 'HK'] as Market[]) {
    for (const i of eligible.filter((x) => x.market === market).slice(0, floor)) chosen.add(i.id);
  }
  for (const i of eligible) {
    if (chosen.size >= size) break;
    chosen.add(i.id);
  }
  return eligible
    .filter((i) => chosen.has(i.id))
    .slice(0, size)
    .map((i) => i.id);
}

// ------------------------------------------------------------------------------------------------------ outcomes
export interface OutcomeBar {
  day: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** What happened to a Setup after the close it was shown on (stamped on the candidate row). */
export interface LeaderOutcome {
  fwd5: number | null;
  fwd10: number | null;
  fwd20: number | null;
  /** A high reached entry + 3R before any low reached the stop (a bar that does both counts as stopped). */
  hit3r: boolean;
  stopped: boolean;
  /**
   * Stopped: the R multiple of the exit (-1 at the stop, below -1 when the bar opened through it). Otherwise the best R any
   * high reached in the window, which is 3 or more once the 3R level was hit.
   */
  maxR: number;
  daysTo3r: number | null;
  /** The last bar counted. */
  outcomeAsOf: ISODate;
  /** Decided (3R or the stop) or the whole window has passed. */
  complete: boolean;
}

export const OUTCOME_WINDOW = 20;

/**
 * Counts from the entry close: `bars` are the sessions after the day the Setup was shown, ascending. Returns null with no
 * bars yet. Deterministic and pure, so the stamping can be replayed.
 */
export function computeOutcome(
  plan: { entry: number; stop: number },
  bars: readonly OutcomeBar[],
  window = OUTCOME_WINDOW,
): LeaderOutcome | null {
  const r = plan.entry - plan.stop;
  if (bars.length === 0 || !(r > 0)) return null;
  const target = plan.entry + 3 * r;
  const used = bars.slice(0, window);
  let hit3r = false;
  let stopped = false;
  let daysTo3r: number | null = null;
  let exitR: number | null = null;
  let bestR = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < used.length; i++) {
    const b = used[i] as OutcomeBar;
    if (!stopped) bestR = Math.max(bestR, (b.high - plan.entry) / r);
    if (hit3r || stopped) continue;
    if (b.open <= plan.stop) {
      stopped = true;
      exitR = (b.open - plan.entry) / r;
    } else if (b.low <= plan.stop) {
      stopped = true;
      exitR = -1;
    } else if (b.high >= target) {
      hit3r = true;
      daysTo3r = i + 1;
    }
  }
  const at = (k: number): number | null =>
    used.length >= k ? (used[k - 1] as OutcomeBar).close / plan.entry - 1 : null;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    fwd5: at(5),
    fwd10: at(10),
    fwd20: at(20),
    hit3r,
    stopped,
    maxR: round(stopped && exitR !== null ? exitR : bestR),
    daysTo3r,
    outcomeAsOf: (used[used.length - 1] as OutcomeBar).day,
    complete: hit3r || stopped || used.length >= window,
  };
}

/**
 * The R multiple a Setup is worth under the method's own rules: out at 3R, or at the stop, else marked at the close of the
 * 20th bar. Null while the trade is still open (neither happened and fewer than 20 bars have passed).
 */
export function realizedR(
  plan: { entry: number; stop: number },
  o: { hit3r: boolean | null; stopped: boolean | null; maxR: number | null; fwd20: number | null },
): number | null {
  if (o.hit3r) return 3;
  if (o.stopped) return o.maxR;
  const r = plan.entry - plan.stop;
  if (o.fwd20 !== null && r > 0) return (o.fwd20 * plan.entry) / r;
  return null;
}
