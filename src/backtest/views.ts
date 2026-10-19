/**
 * Data contracts of the backtest module (docs/05): the shapes a stored backtest is read back in. The server re-exports them in
 * api-types.ts so the HTTP contract and the UI use the same names; the CLI renders the same objects. Types only: no runtime code.
 */
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { DataTier } from '../core/types';

/** A watchlist key (same shape as StockKey in api-types). */
export interface StockKey {
  market: Market;
  symbol: string;
}

export type BacktestStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type TierPolicy = 'real_only' | 'real_then_synthetic' | 'synthetic_only';

export interface BacktestRequestInput {
  name?: string;
  /** Default: every active watchlist name. */
  symbols?: StockKey[];
  from: ISODate;
  to: ISODate;
  tierPolicy: TierPolicy;
  /** Starting capital in the base currency (default: the equity in settings, else 1,000,000). */
  initialCapital?: number;
  /** Also record rejected entries so per-rule attribution works (about twice the compute). */
  observeRejected?: boolean;
  /** Trading days between scans (default 5). */
  scanEveryDays?: number;
  benchmarks?: boolean;
  sensitivity?: boolean;
  walkForward?: { trainMonths: number; testMonths: number } | null;
  /** Nested override of the strategy parameters, e.g. { "option.select": { "deltaMax": 0.2 } }. */
  paramsOverride?: Record<string, unknown>;
}

export interface BacktestHeadline {
  trades: number;
  winRate: number | null;
  totalReturn: number | null;
  cagr: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
}

export interface BacktestSummaryView {
  id: string;
  name: string | null;
  status: BacktestStatus;
  from: ISODate;
  to: ISODate;
  tierPolicy: TierPolicy;
  names: number;
  /** 0 to 100. */
  progress: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  headline: BacktestHeadline | null;
}

export interface BacktestTradeSummary {
  n: number;
  winRate: number | null;
  avgPnl: number | null;
  medianPnl: number | null;
  avgRoc: number | null;
  annualizedRocOnCollateral: number | null;
  profitFactor: number | null;
  avgDaysHeld: number | null;
  exitReasonMix: Record<string, number>;
  assignmentRate: number | null;
  mae: { p50: number; p90: number; max: number } | null;
  tStat: number | null;
}

export interface BacktestEquityMetrics {
  cagr: number | null;
  annualVol: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  maxDrawdownDays: number | null;
  calmar: number | null;
  avgDeployedPct: number | null;
  totalReturn: number | null;
  monthlyReturns: { month: string; ret: number }[];
}

export interface BacktestStockCard {
  n: number;
  winRate: number;
  avgRoc: number;
  maxDD: number;
  tierMix: { real: number; proxy: number; synthetic: number };
  from: string;
  to: string;
}

export interface BacktestMetricsView {
  trades: BacktestTradeSummary & {
    winRateCI: { lo: number; hi: number } | null;
    avgRocCI: { lo: number; hi: number } | null;
    byTier: Partial<Record<DataTier, BacktestTradeSummary>>;
  };
  equity: BacktestEquityMetrics;
  /** Keyed by instrument id. */
  cards: Record<string, BacktestStockCard>;
  attribution: {
    rule: string;
    passed: { n: number; winRate: number | null; avgRoc: number | null };
    failed: { n: number; winRate: number | null; avgRoc: number | null };
  }[];
  benchmarks: {
    equalWeightHold: BacktestEquityMetrics;
    index: Record<string, BacktestEquityMetrics>;
    naive: { equity: BacktestEquityMetrics; trades: BacktestTradeSummary };
  } | null;
  sensitivity: {
    points: { sigmaMultiplier: number; totalReturn: number | null; sharpe: number | null }[];
    robust: boolean | null;
    note: string;
  } | null;
  tierMix: { real: number; proxy: number; synthetic: number };
  scanDays: number;
  skipped: Record<string, number>;
  caveats: string[];
}

export interface BacktestWalkForwardView {
  windows: {
    trainFrom: ISODate;
    trainTo: ISODate;
    testFrom: ISODate;
    testTo: ISODate;
    bestParams: unknown;
    inSample: { sharpe: number | null; totalReturn: number | null; n: number };
    outOfSample: { sharpe: number | null; totalReturn: number | null; n: number };
  }[];
  aggregate: {
    meanInSampleSharpe: number | null;
    meanOutOfSampleSharpe: number | null;
    overfitting: boolean;
    pooledOutOfSampleN: number;
  };
}

export interface BacktestDetailView extends BacktestSummaryView {
  initialCapital: number;
  request: BacktestRequestInput | null;
  metrics: BacktestMetricsView | null;
  /** [day, equity, deployed share] per trading day. */
  equityCurve: [ISODate, number, number][];
  walkForward: BacktestWalkForwardView | null;
}

export interface BacktestTradeView {
  id: number;
  symbol: string;
  market: Market;
  entryDate: ISODate;
  expiry: ISODate;
  strike: number;
  contracts: number;
  entryCredit: number;
  entryDelta: number | null;
  entryUnderlying: number;
  exitDate: ISODate;
  exitReason: string;
  exitDebit: number;
  exitUnderlying: number;
  /** In the base currency. */
  pnl: number;
  roc: number;
  daysHeld: number;
  tier: DataTier;
  /** Observe mode: tracked for attribution, not funded. */
  shadow: boolean;
}

export interface StudyOutcomeView {
  n: number;
  meanFwd: number | null;
  medianFwd: number | null;
  touchRate: number | null;
  meanCapture: number | null;
  winRate: number | null;
}

export interface EventStudyView {
  market: Market;
  symbol: string;
  bars: number;
  from: ISODate | null;
  to: ISODate | null;
  rules: {
    rule: string;
    byHorizon: {
      horizon: number;
      nFired: number;
      nNotFired: number;
      fired: StudyOutcomeView;
      notFired: StudyOutcomeView;
      edge: { winRateDelta: number | null; touchRateDelta: number | null };
    }[];
  }[];
}
