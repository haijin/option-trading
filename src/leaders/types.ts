/**
 * The view types of the Leaders page (docs/designs/leaders-pullback.md). They live here, not in src/server/api-types.ts, so
 * that the CLI (`pnpm cli leaders --json`) and the server build and print the same shape: `api-types.ts` re-exports every
 * name below and `web/src/api/types.ts` re-exports that, so the UI imports them from the usual place.
 *
 * Types only. Fields ending in Pct are percentages (2.4 = 2.4%); fields ending in Ratio are fractions (0.62 = 62%);
 * rank1m / rank3m / rank6m are percentiles 0-100 within the market's screened names.
 */
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { Currency } from '../core/types';

export type LeaderState = 'setup' | 'watch' | 'extended' | 'broken' | 'excluded';
/** A funnel stage: the names that stopped there are listed under it. */
export type LeaderStage = 'screened' | 'leaders' | 'consolidating' | 'shortlist';
export type LeaderPosture = 'entries' | 'watch_only';

export interface LeaderPlanView {
  /** The close of the day shown. */
  entry: number;
  /** Stop-buy one tick above that day's high. */
  altEntry: number;
  stop: number;
  stopPct: number;
  /** 1R in price. */
  r: number;
  /** 0.5% of equity in the name's currency; null while equity (or the FX rate) is not set. */
  riskBudget: number | null;
  /** HK rounds down to the board lot; null while equity is not set. */
  shares: number | null;
  riskAtStop: number | null;
  positionValue: number | null;
  pctOfEquity: number | null;
  r3: number;
  r5: number;
  /** Shares per lot: 1 for US. */
  lot: number;
  /** The HK lot is a default, not a verified stock board lot. */
  lotAssumed: boolean;
  /** One lot already risks more than the budget; the plan still shows one lot. */
  lotTooBig: boolean;
  lotRiskPct: number | null;
}

export interface LeaderLevelView {
  /** 'ema9' | 'ema21' | 'ema50' | 'swing_low' | 'swing_high' | 'gap' | 'avwap_high' | 'avwap_low' | 'base_low'. */
  source: string;
  label: string;
  level: number;
  /** Close versus the level: positive = price is above it. */
  distPct: number;
  /** The support the skill judged to be in play. */
  inPlay: boolean;
}

export interface LeaderWhyView {
  level: 'pass' | 'warn' | 'info';
  text: string;
}

export interface LeaderFlagView {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface LeaderBaseView {
  anchorDay: ISODate;
  depthRatio: number;
  /** Bars since the range high. */
  lenDays: number;
  /** 10-bar range / 20-bar range. */
  contractionRatio: number | null;
  /** Volume of 10 bars / volume of 50 bars. */
  volDryUpRatio: number | null;
  /** ATR now / ATR at the range high. */
  atrRatio: number | null;
}

/** 70 bars, computed on the server so the phone does no indicator work. Arrays are aligned; null = not defined yet. */
export interface LeaderSparkView {
  closes: number[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  /** AVWAP anchored at the range high. */
  avwap: (number | null)[];
  /** The stop of a Setup, for the red line; null for a Watch. */
  stop: number | null;
  /** Index in the arrays of the range high (the AVWAP anchor), or null when it is older than the 70 bars. */
  anchorIndex: number | null;
}

/** The premium-collecting version of the same thesis, for a name on the watchlist with a stored chain. */
export interface LeaderPutAngleView {
  expiry: ISODate;
  strike: number;
  delta: number | null;
  /** Return on collateral for the period to expiry. */
  rocPct: number | null;
  /** How far under the Setup's stop the strike is; null for a Watch (no stop). */
  belowStopPct: number | null;
}

export interface LeaderOutcomeView {
  fwd5Pct: number | null;
  fwd10Pct: number | null;
  fwd20Pct: number | null;
  /** Null until a bar after the day shown has arrived. */
  hit3r: boolean | null;
  stopped: boolean | null;
  maxR: number | null;
  daysTo3r: number | null;
  /** The last bar counted. */
  asOf: ISODate | null;
}

export interface LeaderCandidateView {
  /** leaders_candidates.id: what mute and watch address. */
  id: number;
  instrumentId: number;
  /** Position in the combined list (1-based); null for a name that is not on it (funnel listings). */
  rank: number | null;
  market: Market;
  symbol: string;
  name: string | null;
  currency: Currency;
  state: LeaderState;
  /** First day on the list in the last 10 sessions. */
  isNew: boolean;
  /** On the active watchlist. */
  watched: boolean;
  /** A put chain is stored for it. */
  hasChain: boolean;
  /** Statements are stored (the quality screen is local and needs them). */
  hasStatements: boolean;
  price: number | null;
  changePct: number | null;
  score: number;
  ret1mPct: number | null;
  ret3mPct: number | null;
  ret6mPct: number | null;
  rank1m: number | null;
  rank3m: number | null;
  rank6m: number | null;
  /** 20-day median of close x volume, in the name's currency. */
  dollarVol20: number | null;
  atrPct: number | null;
  distEma21Pct: number | null;
  distAvwapPct: number | null;
  base: LeaderBaseView | null;
  /** The stop width of today's turn-up bar (a Setup, or a Watch whose bar was too wide). */
  stopPct: number | null;
  earningsInDays: number | null;
  earningsKnown: boolean;
  why: LeaderWhyView[];
  flags: LeaderFlagView[];
  /** The model's one-line text (stage L4); null when absent or rejected by the validator. */
  brief: string | null;
  /** Null for a Watch: no plan until a turn-up bar prints. */
  plan: LeaderPlanView | null;
  levels: LeaderLevelView[];
  put: LeaderPutAngleView | null;
  spark: LeaderSparkView;
  /** Finished research reports on the name, for "Research: 3 reports". */
  researchReports: number;
  /** Quality-screen result (null when statements are not stored). */
  quality: { pass: number; total: number } | null;
  /** Why a name that is not on the list stopped where it did (funnel listings). */
  reason: string | null;
  /** Stamped on archived days: what happened after the close the Setup was shown. */
  outcome: LeaderOutcomeView | null;
}

export interface LeaderFunnelView {
  screened: { total: number; US: number; HK: number };
  leaders: number;
  consolidating: number;
  shortlist: number;
  setup: number;
  watch: number;
  /** Names on today's list that were not on the previous run's list. */
  newToday: number;
  dropped: number;
  shortlistByMarket: { US: number; HK: number };
}

export interface LeaderDroppedView {
  instrumentId: number;
  market: Market;
  symbol: string;
  /** "Extended: 12% above the 21-EMA", "Muted by you on 7 Oct, 6 trading days left". */
  reason: string;
  muted: boolean;
}

export interface LeaderRunView {
  id: number;
  market: Market;
  asOf: ISODate;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'partial' | 'failed';
  screened: number;
  leaders: number;
  consolidating: number;
  shortlisted: number;
  regime: string | null;
  posture: LeaderPosture;
  /** Names with a bar on the as-of date / names considered, for "data is thin" notes. */
  coverage: { withBar: number; names: number } | null;
}

export interface LeaderRegimeView {
  /** "Bull · calm". */
  label: string;
  /** The full line: "Bull · calm · VIX 17.2 · SPY and HSI above 200d". */
  line: string;
  posture: LeaderPosture;
  /** 'Entries allowed' | 'Watch only: pullback entries off'. */
  postureText: string;
}

export interface LeadersStatusView {
  refreshing: boolean;
  /** Finish time of the newest run, ISO. */
  lastRunAt: string | null;
  /** The newest run is more than one trading day old. */
  stale: boolean;
  /** Settings has no equity: plans show "set equity in Settings" and no share counts. */
  equityMissing: boolean;
  ai: { available: boolean; auto: boolean; model: string };
}

export interface LeadersView {
  /** The day shown (the latest run's as-of date, or the archive day asked for); null before the first run. */
  asOf: ISODate | null;
  today: ISODate | null;
  isArchive: boolean;
  /** Previous and next day that has a run, for the day navigator. */
  prevDay: ISODate | null;
  nextDay: ISODate | null;
  runs: Record<Market, LeaderRunView | null>;
  regime: LeaderRegimeView | null;
  funnel: LeaderFunnelView;
  /** The stage whose names `candidates` lists. */
  stage: LeaderStage;
  /** One sentence for a stage that cannot list its names ("Names that were not leaders are not stored"). */
  stageNote: string | null;
  candidates: LeaderCandidateView[];
  dropped: LeaderDroppedView[];
  /** The model's two-sentence lead (stage L4); null when absent or rejected. */
  brief: { lead: string; model: string | null } | null;
  status: LeadersStatusView;
}

export interface LeadersCardView {
  asOf: ISODate;
  setups: number;
  newToday: number;
  shortlisted: number;
  posture: LeaderPosture;
}

export interface LeadersDaysView {
  month: string;
  days: { day: ISODate; setups: number; watch: number }[];
  today: ISODate | null;
  earliest: ISODate | null;
}

export interface LeaderRecordExtreme {
  r: number;
  symbol: string;
  day: ISODate;
  /** 'gap through the stop' when the exit was below -1R. */
  note: string | null;
}

/** The app's own forward record over Setup rows; Watch rows that later became Setups are counted separately. */
export interface LeaderRecordView {
  window: '60' | 'all';
  setups: number;
  hit3r: number;
  stopped: number;
  open: number;
  /** Mean R under the method's rules (out at 3R or the stop, else marked at 20 bars) over decided and finished rows. */
  avgR: number | null;
  medianDaysTo3r: number | null;
  best: LeaderRecordExtreme | null;
  worst: LeaderRecordExtreme | null;
  watchToSetup: { became: number; of: number };
  /** The first day any Setup was counted; null with none. */
  since: ISODate | null;
}

export interface LeaderMuteInput {
  days?: number;
  reason?: string;
}

export interface LeaderMuteView {
  days: number;
  until: ISODate;
  reason: string;
}

export interface LeadersRefreshView {
  queued: boolean;
  message: string;
}

export interface LeaderWatchView {
  ok: true;
  market: Market;
  symbol: string;
}
