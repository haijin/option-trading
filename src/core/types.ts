import type { Market } from './calendar';
import type { ISODate } from './dates';

export type { Market } from './calendar';
export type { ISODate } from './dates';

export type Currency = 'USD' | 'HKD' | 'SGD';
export type SolvencyModel = 'altman' | 'property' | 'financial' | 'reit';
export type ReportingFrequency = 'quarterly' | 'semiannual';
export type DataTier = 'real' | 'proxy' | 'synthetic';
export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'NA';
export type OptionRight = 'P' | 'C';
export type PeriodType = 'annual' | 'quarterly' | 'semiannual' | 'ttm';
export type ChainSource = 'yahoo' | 'csv' | 'futu' | 'ibkr' | 'journal' | 'synthetic';

export interface Instrument {
  id: number;
  market: Market;
  /** Canonical symbol: 'AAPL', '0700'. */
  symbol: string;
  name: string | null;
  currency: Currency;
  sector: string | null;
  industry: string | null;
  solvencyModel: SolvencyModel;
  reportingFrequency: ReportingFrequency;
  benchmarkInstrumentId: number | null;
  /** Contract multiplier: board lot for HK, 100 for US. */
  multiplier: number;
  hasListedOptions: boolean;
  providerSymbols: Record<string, unknown>;
}

export interface DailyBar {
  day: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
  source: string;
}

export interface FundamentalStatement {
  periodEnd: ISODate;
  periodType: PeriodType;
  /** ISO timestamp. Point-in-time anchor: a statement is visible only when reportedAt <= asOf (end of day). */
  reportedAt: string;
  reportedAtEstimated: boolean;
  firstSeenAt: string;
  currency: Currency;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebit: number | null;
  ebitda: number | null;
  interestExpense: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  sharesDiluted: number | null;
  totalAssets: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  totalLiabilities: number | null;
  longTermDebt: number | null;
  totalDebt: number | null;
  cash: number | null;
  retainedEarnings: number | null;
  totalEquity: number | null;
  cfo: number | null;
  capex: number | null;
  fcf: number | null;
  dividendsPaid: number | null;
  buybacks: number | null;
  source: string;
}

export interface PointInTimeFundamentals {
  /** Statements with reportedAt <= asOf, ascending by periodEnd. */
  statements: FundamentalStatement[];
}

export interface OptionQuote {
  expiry: ISODate;
  strike: number;
  right: OptionRight;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  multiplier: number;
}

export interface OptionChainSnapshot {
  snapshotDate: ISODate;
  underlyingPrice: number;
  source: ChainSource;
  tier: DataTier;
  quotes: OptionQuote[];
}

export type EventType =
  | 'earnings'
  | 'ex_dividend'
  | 'agm'
  | 'rights_issue'
  | 'spin_off'
  | 'split'
  | 'index_rebalance'
  | 'other';

export interface CorporateEvent {
  type: EventType;
  date: ISODate;
  confirmed: boolean;
  source: string;
  knownAt: string;
  details: Record<string, unknown> | null;
}

export interface EventCalendar {
  /** Events with knownAt <= asOf. */
  events: CorporateEvent[];
}

export interface IvPoint {
  day: ISODate;
  iv30: number;
  tier: DataTier;
  /** Front / next expiry IV stored with the point (iv_daily.term_ratio), when the ingest recorded one. */
  termRatio?: number | null;
}

export interface MarketRegimeSnapshot {
  market: Market;
  indexSymbol: string;
  indexBars: DailyBar[];
  volIndexSymbol: string | null;
  volIndexBars: DailyBar[];
}

/** Last-seen dates of every input a scan depends on; used by the freshness gate. All bounded by asOf. */
export interface DataSources {
  barsLast: ISODate | null;
  indexLast: ISODate | null;
  volIndexLast: ISODate | null;
  fxLast: ISODate | null;
  chain: { snapshotDate: ISODate; source: ChainSource } | null;
}

export interface CalibrationSummary {
  /** Median real/synthetic price ratio per delta bucket from pasted chains (the unbiased primary set), n >= minSamples only. */
  priceRatio: Record<string, { n: number; median: number }>;
  /** Same ratio from journal fills: a selection-biased sanity figure, never used for pricing. */
  journalRatio: Record<string, { n: number; median: number }>;
  /** Median implied IV / realised-vol ratio for the market from pasted chains, if derivable. */
  ivRvRatio: { n: number; median: number } | null;
}

/** One calibration sample, as stored in pricing_calibration plus the contract's market-independent facts. */
export interface CalibrationRow {
  day: ISODate;
  bucket: string;
  /** real price / synthetic price on the same contract and day. */
  ratio: number;
  /** implied IV of the real price divided by the realised-vol sigma used, when derivable. */
  ivRvRatio: number | null;
  /** 'csv' (primary, unbiased) | 'journal' (sanity only) | other chain sources. */
  source: string;
}

/** Realised outcomes on this name from the imported journal, for the journal-derived backtest card. */
export interface JournalOutcome {
  openDate: ISODate;
  closeDate: ISODate;
  pnl: number;
  collateral: number;
}

export interface OpenPosition {
  instrumentId: number;
  symbol: string;
  market: Market;
  sector: string | null;
  currency: Currency;
  strike: number;
  multiplier: number;
  quantity: number;
  expiry: ISODate;
}

export interface PortfolioState {
  baseCurrency: Currency;
  /** null until `settings set equity`. */
  equity: number | null;
  openPositions: OpenPosition[];
  /** Collateral (base currency) and per-sector put counts already committed by better-ranked names in THIS run. */
  committedBase?: number;
  committedBySector?: Record<string, number>;
  /** Rate to convert one unit of `from` into the base currency (1 for the base itself). */
  fxToBase(from: Currency): number | null;
  /** Drawdown governor settings (portfolio_settings); absent or all-null means no limit and a size multiplier of 1. */
  governor?: GovernorSettings;
}

/** One de-gear tier: at or past `drawdownPct` percent of equity under the P&L peak, size is multiplied by `multiplier`. */
export interface DegearTier {
  drawdownPct: number;
  multiplier: number;
}

/** The drawdown governor (docs/designs/trade-skills-integration.md T3, pitfall 31). Defaults leave sizing unchanged. */
export interface GovernorSettings {
  /** Day P&L (realised plus the change in marks, base currency) at or below minus this halts new puts for the day. */
  dailyLossLimit: number | null;
  /** This many consecutive losing closes halts new puts; null switches the rule off. */
  consecutiveLossHalt: number | null;
  /** Drawdown tiers, any order; the deepest tier reached applies. Empty means multiplier 1. */
  degearTiers: DegearTier[];
}

/** A recorded put as the governor sees it: when it was open and what it realised, with its own currency. */
export interface LedgerPosition {
  positionId: number;
  currency: Currency;
  openDate: ISODate;
  /** null while open. */
  closeDate: ISODate | null;
  /** Booked P&L in the position's currency (fees included); null while open. */
  realizedPnl: number | null;
}

/** One stored mark: the open put's unrealised P&L (its own currency) on `day`. */
export interface LedgerMark {
  positionId: number;
  day: ISODate;
  unrealizedPnl: number;
}

/** Positions and marks the governor reads, bounded by asOf by the DataAccess that serves it. */
export interface PnlLedger {
  positions: LedgerPosition[];
  marks: LedgerMark[];
}

export interface Reason {
  rule: string;
  value: number | string | boolean | null;
  threshold?: string;
  passed: boolean;
  weight?: number;
  note?: string;
  /** 'rule' WARNs apply the composite multiplier; 'data' WARNs (data-quality) do not. */
  kind?: 'rule' | 'data';
  level?: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
}
