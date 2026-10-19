/**
 * The HTTP contract between the local server (src/server) and the web UI (web/). Types only: no runtime code, no imports
 * from the rest of src, so the UI can `import type` from here without pulling server code into its bundle.
 *
 * Conventions
 *  - Every endpoint lives under /api and speaks JSON (except the two `.md` / `.csv` downloads).
 *  - Money and price fields are plain numbers in the instrument's trading currency unless the name ends in `Base`
 *    (then the portfolio base currency, HKD by default). Percent fields end in `Pct` and are percentages (5.0 = 5%),
 *    never fractions, except `ratio` fields which are fractions (0.93 = 93%).
 *  - Dates are `YYYY-MM-DD`; timestamps are ISO-8601 UTC strings.
 *  - Errors: HTTP 4xx/5xx with body `ApiErrorBody`. `code` is stable and machine-readable, `message` is for people.
 */

import type { JournalDocJson, JournalMarketView, JournalStatus, JournalTemplateId } from '../journal/types';
import type { LeadersCardView } from '../leaders/types';

export type Market = 'US' | 'HK';
export type ISODate = string;
export type Currency = 'USD' | 'HKD' | 'SGD';
export type DataTier = 'real' | 'proxy' | 'synthetic';
export type Level = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'NA';
export type SolvencyModel = 'altman' | 'property' | 'financial' | 'reit';
export type ReportingFrequency = 'quarterly' | 'semiannual';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface StockKey {
  market: Market;
  symbol: string;
}

// ------------------------------------------------------------------------------------------------ health / overview
export interface HealthView {
  ok: boolean;
  version: string;
  database: { connected: boolean; name: string };
  now: string;
}

export interface RegimeView {
  market: Market;
  /** Machine label from S0, e.g. 'bull_calm'. */
  regime: string;
  /** Human label, e.g. 'bull-calm'. */
  label: string;
  deployCapPct: number;
  deltaCap: number;
  note: string;
  usedVolIndex: boolean;
}

export interface DeployView {
  /** Collateral of open puts in the base currency (full notional, strike x multiplier). */
  amountBase: number;
  pctOfEquity: number;
  capPct: number;
  allowedBase: number;
}

export interface WatchlistCounts {
  watching: number;
  paused: number;
  us: number;
  hk: number;
  pendingFirstIngest: number;
}

export interface IngestSummaryView {
  at: string;
  ok: number;
  failed: number;
  skipped: number;
  rows: number;
}

export interface OverviewView {
  asOf: ISODate;
  generatedAt: string;
  baseCurrency: Currency;
  equity: number | null;
  fxUsdHkd: number | null;
  regime: Partial<Record<Market, RegimeView>>;
  deployed: Record<Market, DeployView>;
  watchlist: WatchlistCounts;
  data: { lastIngest: IngestSummaryView | null; currentNames: number; staleNames: number };
  lastScan: { id: string; at: string; asOf: ISODate; ideas: number } | null;
  /** The Leaders card on Today; null until a leaders scan has run. */
  leaders: LeadersCardView | null;
  disclaimer: string;
}

// ------------------------------------------------------------------------------------------------ scan (Today)
export interface ReasonView {
  rule: string;
  value: number | string | boolean | null;
  threshold: string | null;
  level: Level;
  /** 'data' = a data-quality note that never penalises the composite. */
  kind: 'rule' | 'data' | null;
  note: string | null;
  /** UI grouping: Market | Quality gate | Events | Timing | Volatility | Option | Rank | Sizing | Freshness | Other. */
  group: string;
  skillId: string;
}

export interface SkillRowView {
  skillId: string;
  version: string;
  verdict: Verdict;
  score: number | null;
  tier: DataTier;
  missing: string[];
}

export interface ContractView {
  expiry: ISODate;
  dte: number;
  strike: number;
  /** Absolute put delta as a fraction (0.20 = 20 delta). */
  delta: number;
  /** Premium per share. */
  premium: number;
  multiplier: number;
  /** Premium x multiplier. */
  credit: number;
  /** Full notional: strike x multiplier. */
  collateral: number;
  collateralBase: number | null;
  annRocPct: number;
  rocPct: number;
  cushionPct: number;
  breakeven: number;
  /** Fractions (0.2 = 20%), unlike the `Pct` fields. */
  probItm: number | null;
  expectedValue: number | null;
  bid: number | null;
  ask: number | null;
  /** Implied volatility as a fraction (0.31 = 31%). */
  iv: number | null;
  /** 'yahoo' | 'csv' | 'futu' | 'ibkr' | 'journal' | 'synthetic'. */
  priceSource: string;
  tier: DataTier;
}

export interface SizingView {
  contracts: number;
  collateralBase: number;
  pctOfEquity: number;
  capsHit: string[];
  sizeFactor: number;
}

export interface ValueBadge {
  /** Base intrinsic value per share in trading currency. */
  base: number;
  priceRatio: number;
  /** Net cost basis (strike minus premium) over intrinsic value, when a put is proposed. */
  costRatio: number | null;
  stars: 1 | 2 | 3 | 4 | 5;
}

export interface EarningsView {
  date: ISODate;
  confirmed: boolean;
  source: string;
}

export interface IdeaView {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  currency: Currency;
  rank: number;
  composite: number;
  confidence: number | null;
  tier: DataTier;
  staleTagged: boolean;
  spot: number;
  support: number | null;
  supportSource: string | null;
  trend: 'up' | 'down' | 'side' | null;
  contract: ContractView;
  sizing: SizingView | null;
  ruleWarns: string[];
  narrative: { headline: string; lines: string[] } | null;
  reasons: ReasonView[];
  skills: SkillRowView[];
  nextEarnings: EarningsView | null;
  value: ValueBadge | null;
}

export type RejectStatus = 'dropped_stale' | 'failed' | 'excluded' | 'cut' | 'no_contract';

export interface RejectView {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  status: RejectStatus;
  /** Rule that decided it, e.g. 'events.earningsWindow', 'data.stale'. */
  bindingRule: string;
  detail: string;
  skillId: string | null;
  staleLastBar: ISODate | null;
  reasons: ReasonView[];
  skills: SkillRowView[];
  value: ValueBadge | null;
}

export interface OpenNameView {
  symbol: string;
  market: Market;
  name: string | null;
  contracts: number;
}

export interface ScanView {
  asOf: ISODate;
  generatedAt: string;
  paramsLabel: string;
  stats: { cacheHits: number; computed: number; durationMs: number };
  ideas: IdeaView[];
  rejected: RejectView[];
  openNames: OpenNameView[];
  pasteChainsFor: { symbol: string; market: Market; composite: number }[];
  /** Set when the run was stored with POST /api/scan/run. */
  savedRunId: string | null;
  /** Watched names that have no price data yet (never ingested), so they could not be scored. */
  waitingForData: { symbol: string; market: Market }[];
}

/** What the full pipeline concluded about one name. */
export type ExplainStatus = 'ranked' | 'candidate' | 'dropped_stale' | 'failed' | 'excluded' | 'cut' | 'no_contract';

export interface ExplainView {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  asOf: ISODate;
  status: ExplainStatus;
  binding: { skillId: string; rule: string; detail: string } | null;
  skills: SkillRowView[];
  reasons: ReasonView[];
  contract: ContractView | null;
  narrative: { headline: string; lines: string[] } | null;
  freshness: { stale: { source: string; last: ISODate | null; detail: string }[]; chainFresh: boolean };
  events: { type: string; date: ISODate; confirmed: boolean; source: string }[];
}

export interface ChartView {
  symbol: string;
  market: Market;
  currency: Currency;
  asOf: ISODate;
  last: number;
  bars: { day: ISODate; close: number }[];
  /** Same length as `bars`; null while the average is not yet defined. */
  sma50: (number | null)[];
  sma200: (number | null)[];
  support: number | null;
  supportSource: string | null;
  strike: number | null;
  breakeven: number | null;
}

// ------------------------------------------------------------------------------------------------ value / KPIs
export type KpiGroup = 'Profitability' | 'Cash quality' | 'Safety' | 'Growth' | 'Valuation' | 'Shareholder';

export interface KpiRowView {
  group: KpiGroup;
  key: string;
  label: string;
  value: number | null;
  unit: '%' | 'x' | 'yrs' | 'num' | 'text';
  /** Display text when `unit` is 'text' (e.g. 'net cash') or a note on the value. */
  text: string | null;
  status: 'ok' | 'warn' | 'fail' | 'info';
  /** Rule of thumb, e.g. '>= 8% (screen filter 1)'. */
  rule: string;
  /** Up to 5 yearly values, oldest first, for a sparkline. */
  trend: number[] | null;
  /** Data window caveat, e.g. '4y of 10y'. */
  window: string | null;
}

export interface QuarterRowView {
  label: string;
  revenueYoyPct: number | null;
  grossMarginPct: number | null;
  epsSurprisePct: number | null;
}

export interface ScreenRowView {
  n: number;
  label: string;
  valueText: string;
  rule: string;
  status: 'pass' | 'warn' | 'fail' | 'exempt' | 'na';
  note: string;
}

export interface ScreenView {
  verdict: 'PASS' | 'EXEMPT-PASS' | 'EXCLUDED' | 'INCOMPLETE';
  rows: ScreenRowView[];
  borderline: number;
  /** Years of annual statements actually available (free data gives about 4). */
  windowYears: number;
}

export interface ScenarioView {
  name: 'Bull' | 'Base' | 'Bear';
  growthPct: number;
  targetPe: number;
  eps3y: number;
  price3y: number;
  dividends3y: number;
  presentValue: number;
}

export interface MethodView {
  id: 'scenario' | 'dcf' | 'fair_value';
  label: string;
  value: number;
  note: string;
}

export interface AssumptionParam {
  value: number | null;
  /** 'data' = derived from stored statements, 'default' = a fixed default, 'override' = set by you. */
  source: 'data' | 'default' | 'override';
  note: string | null;
}

export interface AssumptionsView {
  eps: AssumptionParam;
  dividendPerShare: AssumptionParam;
  fcfPerShare: AssumptionParam;
  /** EPS growth per year, percent, [bull, base, bear]. */
  growthPct: [AssumptionParam, AssumptionParam, AssumptionParam];
  /** Target P/E in three years, [bull, base, bear]. */
  targetPe: [AssumptionParam, AssumptionParam, AssumptionParam];
  dcfGrowthPct: AssumptionParam;
  terminalGrowthPct: number;
  requiredReturnPct: AssumptionParam;
}

export interface IntrinsicView {
  currency: Currency;
  price: number;
  requiredReturnPct: number;
  /** Median of the available methods; null when no method could be computed. */
  base: number | null;
  low: number | null;
  high: number | null;
  priceRatio: number | null;
  /** (base - price) / base, percent; positive = price below intrinsic value. */
  marginOfSafetyPct: number | null;
  stars: 1 | 2 | 3 | 4 | 5 | null;
  methods: MethodView[];
  scenarios: ScenarioView[];
  reverse: {
    impliedGrowthPct: number;
    historicalEpsCagrPct: number | null;
    verdict: 'demanding' | 'in line' | 'undemanding';
  } | null;
  assumptions: AssumptionsView;
  /** Proposed put, if any: strike and net cost over intrinsic value. */
  proposedPut: { strike: number; breakeven: number; strikeRatio: number; costRatio: number } | null;
  warnings: string[];
}

export interface FairValueView {
  value: number;
  asOf: ISODate;
  moat: string | null;
  uncertainty: string | null;
  source: string;
}

export interface ValueView {
  symbol: string;
  market: Market;
  asOf: ISODate;
  currency: Currency;
  hasFundamentals: boolean;
  fundamentals: { annual: number; quarterly: number; lastPeriodEnd: ISODate | null };
  kpis: KpiRowView[];
  quarters: QuarterRowView[];
  screen: ScreenView;
  intrinsic: IntrinsicView | null;
  fairValue: FairValueView | null;
  overrides: ValuationOverrides | null;
}

/** Per-stock overrides of the valuation assumptions; any field may be omitted. */
export interface ValuationOverrides {
  growthPct?: [number, number, number];
  targetPe?: [number, number, number];
  dcfGrowthPct?: number;
  requiredReturnPct?: number;
}

// ------------------------------------------------------------------------------------------------ watchlist
export interface WatchStatus {
  kind: 'idea' | 'rejected' | 'open_put' | 'stale' | 'paused' | 'pending_first_ingest' | 'no_data' | 'unscored';
  label: string;
  detail: string | null;
}

export interface WatchEntryView {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  currency: Currency;
  boardLot: number;
  solvencyModel: SolvencyModel;
  /** True while the model is still the default and no ingest or user choice has fixed it. */
  solvencyInferred: boolean;
  reportingFrequency: ReportingFrequency;
  conviction: number | null;
  notes: string | null;
  maxCollateralPct: number | null;
  active: boolean;
  addedAt: string;
  hasOpenPut: boolean;
  nextEarnings: EarningsView | null;
  status: WatchStatus;
}

export interface WatchPreviewView {
  ok: boolean;
  error: string | null;
  raw: string;
  market: Market | null;
  symbol: string | null;
  yahooSymbol: string | null;
  /** Name from the HK lot file or an existing row; null until the first ingest otherwise. */
  name: string | null;
  boardLot: number | null;
  /** 'seed_file' = data/hk-board-lots.csv, 'us_default' = 100 shares, 'existing' = already stored, 'missing' = HK name not in the file. */
  lotSource: 'seed_file' | 'us_default' | 'existing' | 'missing' | null;
  duplicate: 'watching' | 'paused' | null;
}

export interface WatchAddInput {
  symbol: string;
  market?: Market;
  boardLot?: number;
  solvencyModel?: SolvencyModel;
  reportingFrequency?: ReportingFrequency;
  conviction?: number | null;
  notes?: string | null;
  maxCollateralPct?: number | null;
}

export interface WatchPatch {
  active?: boolean;
  boardLot?: number;
  solvencyModel?: SolvencyModel;
  reportingFrequency?: ReportingFrequency;
  conviction?: number | null;
  notes?: string | null;
  maxCollateralPct?: number | null;
  name?: string | null;
}

export interface WatchBulkInput {
  op: 'stop' | 'resume';
  keys: StockKey[];
}

export interface WatchPasteRow {
  raw: string;
  ok: boolean;
  error: string | null;
  market: Market | null;
  symbol: string | null;
  name: string | null;
  boardLot: number | null;
  result: 'new' | 'resume' | 'already_watching' | 'invalid' | 'lot_unknown';
}

export interface WatchPasteView {
  rows: WatchPasteRow[];
  /** Present only when applied. */
  /** Zero unless the request had `apply: true`. */
  added: number;
  resumed: number;
  skipped: number;
  invalid: number;
}

// ------------------------------------------------------------------------------------------------ watchlist board
/** What to do with a watched name today. `hold` = an open put is already there; `needs_data` = it cannot be scored yet. */
export type WatchActionKind = 'sell_put' | 'wait' | 'avoid' | 'hold' | 'needs_data';

export interface WatchAction {
  kind: WatchActionKind;
  /** 'Sell put' | 'Wait' | 'Avoid' | 'Hold' | 'Needs data'. */
  label: string;
  /** One plain sentence: why. */
  reason: string;
}

export interface WatchHighlight {
  tone: 'good' | 'warn' | 'info';
  text: string;
}

/** The put the scan proposes, present when the action is `sell_put`. */
export interface WatchPutView {
  strike: number;
  expiry: ISODate;
  dte: number;
  /** Absolute put delta as a fraction (0.20 = 20 delta). */
  delta: number;
  premium: number;
  annRocPct: number;
  cushionPct: number;
  /** Rule warnings the idea carries (they do not block it). */
  warns: number;
}

/** One watched stock with the numbers the board shows. Every number may be null when its input is missing: nothing is invented. */
export interface WatchBoardRow {
  symbol: string;
  market: Market;
  name: string | null;
  sector: string | null;
  currency: Currency;
  conviction: number | null;
  hasOpenPut: boolean;
  /** Last close, in the trading currency. */
  price: number | null;
  /** Date of that close. */
  lastBar: ISODate | null;
  /** Change since the previous close, percent. */
  changePct: number | null;
  /** Up to 60 closes, oldest first, for the sparkline. */
  closes: number[];
  trend: 'up' | 'down' | 'side' | null;
  /** How far the price is above the support level, percent of price (negative = below it). */
  supportDistPct: number | null;
  rsi14: number | null;
  /** 0 to 100. */
  ivRank: number | null;
  /** 5-year average return on equity, percent. */
  roePct: number | null;
  fcfYieldPct: number | null;
  /** Trailing price / earnings. */
  pe: number | null;
  /** Price against intrinsic value (base case); null with no fundamentals. */
  value: ValueBadge | null;
  screen: ScreenView['verdict'] | null;
  nextEarnings: EarningsView | null;
  /** Calendar days from `asOf` to the next results date (0 = today); null when unknown or already past. */
  earningsInDays: number | null;
  /** Rank in today's shortlist (1 = best), when it is an idea. */
  rank: number | null;
  composite: number | null;
  put: WatchPutView | null;
  action: WatchAction;
  /** At most three, most important first. */
  highlights: WatchHighlight[];
}

export interface WatchBoardView {
  /** The session the numbers describe. */
  asOf: ISODate;
  generatedAt: string;
  /** Active (watched) names only; paused ones are in GET /api/watchlist. */
  rows: WatchBoardRow[];
  /** False when the scan could not run (no equity set): every action is then "needs data". */
  scored: boolean;
}

// ------------------------------------------------------------------------------------------------ positions / journal
/** Mirrors AlertCode in src/core/alerts.ts (this file imports nothing); a test keeps the two equal. */
export type AlertCode =
  | 'profit50'
  | 'dte21'
  | 'stop2x'
  | 'assignment_risk'
  | 'itm'
  | 'near_strike'
  | 'earnings_before_expiry'
  | 'new_earnings_date'
  | 'drawdown_tier';

export interface AlertView {
  level: 'info' | 'warn' | 'fail';
  code: AlertCode;
  text: string;
}

export interface PositionView {
  id: number;
  symbol: string;
  market: Market;
  name: string | null;
  currency: Currency;
  strike: number;
  expiry: ISODate;
  dte: number;
  quantity: number;
  multiplier: number;
  openDate: ISODate;
  /** Premium per share received. */
  openPrice: number;
  /** openPrice x multiplier x quantity. */
  credit: number;
  /** Full notional: strike x multiplier x quantity. */
  collateral: number;
  collateralBase: number | null;
  status: 'open' | 'closed' | 'expired' | 'assigned' | 'rolled';
  closeDate: ISODate | null;
  closePrice: number | null;
  realizedPnl: number | null;
  /** Last stored close of the underlying and its distance to the strike, percent ((spot - strike) / spot). */
  spot: number | null;
  distancePct: number | null;
  alerts: AlertView[];
  /** Latest stored mark (option price per share), P&L and the day it was taken; null until the mark job has run for this put. */
  mark: PositionMarkView | null;
  source: 'manual' | 'journal_import';
  /** Whether the stock is still on the active watchlist (an open put is tracked either way). */
  watching: boolean;
}

export interface JournalSummaryView {
  trades: number;
  wins: number;
  winRatePct: number | null;
  /** Realised P&L per currency. */
  realised: Partial<Record<Currency, number>>;
}

export interface PositionsView {
  open: PositionView[];
  closed: PositionView[];
  journal: JournalSummaryView;
  deployed: Record<Market, DeployView>;
  /** True when at least one open put has a stored mark. */
  marksAvailable: boolean;
  /** Shares received from assigned puts (the wheel). */
  lots: LotView[];
}

export interface PositionMarkView {
  day: ISODate;
  /** Option price per share. */
  price: number;
  /** (credit - mark) x multiplier x contracts, before closing fees. */
  unrealizedPnl: number;
  /** Share of the credit already captured, 0.5 = 50%. */
  pctCaptured: number | null;
  delta: number | null;
  /** real: a stored quote; synthetic: model price. */
  tier: 'real' | 'proxy' | 'synthetic';
}

export interface LotView {
  id: number;
  symbol: string;
  market: Market;
  name: string | null;
  currency: Currency;
  shares: number;
  /** Underlying close at assignment (the booking basis). */
  costBasis: number;
  /** Strike less net premium per share: compare a covered-call strike with this. */
  effectiveCost: number | null;
  openDate: ISODate;
  status: 'open' | 'sold';
  closeDate: ISODate | null;
  closePrice: number | null;
  realizedPnl: number | null;
  /** Last stored close of the underlying and the unrealised P&L against the booking basis (open lots). */
  spot: number | null;
  unrealizedPnl: number | null;
}

export interface LotSellInput {
  price: number;
  date?: ISODate;
  fees?: number;
}

export interface MarkRunView {
  asOf: ISODate;
  marked: number;
  skipped: { symbol: string; reason: string }[];
  alerts: {
    symbol: string;
    strike: number;
    expiry: ISODate;
    code: AlertCode;
    level: 'info' | 'warn' | 'fail';
    text: string;
  }[];
}

export interface PositionAddInput {
  symbol: string;
  market?: Market;
  strike: number;
  expiry: ISODate;
  contracts: number;
  /** Premium per share received. */
  price: number;
  date?: ISODate;
  fees?: number;
  spot?: number;
}

export interface PositionCloseInput {
  kind: 'bought_back' | 'expired' | 'assigned';
  /** Buy-back premium per share (bought_back only). */
  price?: number;
  date?: ISODate;
  fees?: number;
  underlyingClose?: number;
}

export interface JournalImportInput {
  csv: string;
}

export interface JournalImportView {
  ok: boolean;
  imported: number;
  skippedExisting: number;
  quotesWritten: number;
  totals: string[];
  warnings: string[];
  errors: string[];
}

// ------------------------------------------------------------------------------------------------ settings
/** One de-gear tier of the drawdown governor: at `drawdownPct` percent of equity under the P&L peak, size x `multiplier`. */
export interface DegearTierView {
  drawdownPct: number;
  multiplier: number;
}

/** The drawdown governor (trade-skills T3, pitfall 31). Null limits and no tiers leave sizing unchanged. */
export interface GovernorSettingsView {
  /** Base currency; a day P&L at or below minus this halts new puts for the day. */
  dailyLossLimit: number | null;
  /** Consecutive losing closes that halt new puts. */
  consecutiveLossHalt: number | null;
  degearTiers: DegearTierView[];
}

export interface SettingsView {
  baseCurrency: Currency;
  equity: number | null;
  governor: GovernorSettingsView;
  perNameCapPct: number;
  params: { name: string; version: number; hash: string; tree: unknown };
  database: { name: string; host: string; port: number };
  skills: {
    root: string;
    rootFound: boolean;
    python: string | null;
    claudeCli: string | null;
    executor: 'claude-cli' | 'fake' | 'none';
  };
}

export interface SettingsPatch {
  equity?: number;
  baseCurrency?: Currency;
  /** Fields given are set; a null limit switches that rule off; an empty tier list clears the tiers. */
  governor?: Partial<GovernorSettingsView>;
}

// ------------------------------------------------------------------------------------------------ data / ingest
export interface IngestItemView {
  target: string;
  step: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

export interface IngestJobView {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** 'all' or the list of symbols fetched. */
  scope: 'all' | StockKey[];
  log: string[];
  items: IngestItemView[];
  summary: { ok: number; failed: number; skipped: number; rows: number } | null;
  error: string | null;
  /** Names skipped because they are paused. */
  pausedSkipped: string[];
}

export interface IngestStartInput {
  /** Omit for every watched stock. */
  only?: StockKey[];
}

export interface DataStatusRow {
  symbol: string;
  market: Market;
  name: string | null;
  lastBar: ISODate | null;
  /** Close of the last stored bar: the spot suggested when pasting a chain. */
  lastClose: number | null;
  chain: { source: string; date: ISODate } | null;
  nextEarnings: EarningsView | null;
  fundamentals: { annual: number; quarterly: number; lastPeriodEnd: ISODate | null };
  stale: boolean;
  priceVsIv: ValueBadge | null;
  status: WatchStatus;
}

export interface ProviderStatusView {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'fail' | 'unknown';
  detail: string;
}

export interface DataStatusView {
  lastIngest: IngestJobView | null;
  names: DataStatusRow[];
  providers: ProviderStatusView[];
  files: {
    boardLots: { path: string; rows: number };
    vhsi: { path: string; found: boolean };
  };
}

export interface ChainImportInput {
  symbol: string;
  market?: Market;
  csv: string;
  spot: number;
  date: ISODate;
}

export interface ChainImportView {
  ok: boolean;
  stored: number;
  expiries: ISODate[];
  /** 30-day implied volatility of the pasted chain as a fraction (0.31 = 31%), when derivable. */
  iv30: number | null;
  warnings: string[];
  errors: string[];
}

export interface EventAddInput {
  symbol: string;
  market?: Market;
  type: 'earnings' | 'ex_dividend' | 'agm' | 'rights_issue' | 'spin_off' | 'split' | 'index_rebalance' | 'other';
  date: ISODate;
  confirmed?: boolean;
}

export interface FairValueImportInput {
  /** Morningstar fair-value CSV as produced by Invest-agent/tools/morningstar_fair_value.py. */
  csv: string;
  asOf?: ISODate;
}

export interface FairValueImportView {
  matched: number;
  unmatched: string[];
  asOf: ISODate;
}

// ------------------------------------------------------------------------------------------------ reminders (docs/designs/app-dashboard.md)
export type { ReminderKind, ReminderLevel, RemindersView, ReminderView } from '../core/reminders';

// ------------------------------------------------------------------------------------------------ research (skills)
export type SkillId =
  | 'quality-screen'
  | 'investment-checklist'
  | 'investment-research'
  | 'earnings-review'
  | 'management-deep-dive'
  | 'news-pulse'
  | 'thesis-tracker';

export interface SkillInfoView {
  id: SkillId;
  zhName: string;
  enName: string;
  effort: 'local' | 'light' | 'medium' | 'heavy';
  does: string;
  steps: string[];
  /** Runs entirely from stored numbers, no AI. */
  local: boolean;
  available: boolean;
  unavailableReason: string | null;
}

export interface PresetView {
  id: 'assign' | 'numbers' | 'full' | 'leader';
  name: string;
  description: string;
  skillIds: SkillId[];
}

export interface SkillCatalogView {
  skills: SkillInfoView[];
  presets: PresetView[];
  executor: 'claude-cli' | 'fake' | 'none';
  root: string;
  notes: string[];
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ResearchRunView {
  id: string;
  symbol: string;
  market: Market;
  skillId: SkillId;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: string[];
  /** Index of the step the run is on (AI runs infer it from streamed output). */
  stepIndex: number;
  /** Last lines of progress output. */
  progress: string[];
  costUsd: number | null;
  model: string | null;
  error: string | null;
  hasReport: boolean;
  /** "pass N of M" for quality-screen; extracted from report for AI skills; null if not yet available. */
  verdict: string | null;
}

export interface ResearchRunDetailView extends ResearchRunView {
  report: { format: 'markdown'; markdown: string } | { format: 'screen'; screen: ScreenView } | null;
}

export interface ResearchStartInput {
  symbol: string;
  market?: Market;
  skillIds: SkillId[];
}

// ------------------------------------------------------------------------------------------------ ask (trade-skills T2)
/** What a question is about: the current idea for a name on Today, or one put on the Positions page. */
export type AskTarget = { kind: 'idea'; market: Market; symbol: string } | { kind: 'position'; positionId: number };

export interface AskStartInput {
  target: AskTarget;
  /** 1 to 600 characters, any language. */
  question: string;
}

/** One question and its answer: a research_runs row of kind 'ask'. */
export interface AskItemView {
  id: string;
  target: AskTarget;
  symbol: string;
  market: Market;
  question: string;
  /** Plain Markdown; present when `status` is `done`. */
  answer: string | null;
  status: RunStatus;
  error: string | null;
  /** Pitfall numbers attached to the prompt (the knowledge bundle's ids, e.g. 36, 19). */
  pitfalls: number[];
  /** What the prompt was grounded on, one phrase each ("idea from the scan of 2026-10-18, 31 reasons"). */
  grounding: string[];
  progress: string[];
  model: string | null;
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AskThreadView {
  target: AskTarget;
  symbol: string;
  market: Market;
  name: string | null;
  /** Oldest first. */
  items: AskItemView[];
  executor: 'claude-cli' | 'fake' | 'none';
  limits: { perRunUsd: number; dailyUsd: number; spentTodayUsd: number; runsToday: number };
}

// ------------------------------------------------------------------------------------------------ leaders
// The Leaders page's view types are defined in src/leaders/types.ts (shared with the CLI) and re-exported here.
export type {
  LeaderBaseView,
  LeaderCandidateView,
  LeaderDroppedView,
  LeaderFlagView,
  LeaderFunnelView,
  LeaderLevelView,
  LeaderMuteInput,
  LeaderMuteView,
  LeaderOutcomeView,
  LeaderPlanView,
  LeaderPosture,
  LeaderPutAngleView,
  LeaderRecordExtreme,
  LeaderRecordView,
  LeaderRegimeView,
  LeaderRunView,
  LeaderSparkView,
  LeaderStage,
  LeaderState,
  LeadersCardView,
  LeadersDaysView,
  LeadersRefreshView,
  LeadersStatusView,
  LeadersView,
  LeaderWatchView,
  LeaderWhyView,
} from '../leaders/types';

// ------------------------------------------------------------------------------------------------ sign-in
export interface AuthUserView {
  id: string;
  username: string;
  email: string;
}

/** `GET /api/auth/session`: always answered, signed in or not. It is what the login page is drawn from. */
export interface AuthSessionView {
  /** False when the server runs with OT_AUTH=off: there is no login and `user` stays null. */
  authRequired: boolean;
  user: AuthUserView | null;
  /** No account exists yet: the first one is created from the login page. */
  setupRequired: boolean;
  /** This request may create it: only from the machine itself, never through the public address. */
  canSetup: boolean;
  /** Where to open the app on the server's machine to create the first account (shown when `canSetup` is false). */
  localUrl: string;
  providers: {
    password: true;
    /** False until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. */
    google: boolean;
    emailLink: true;
    /** `console` means no mail server is configured: the link is printed in the server's terminal. */
    emailDelivery: 'smtp' | 'console';
  };
}

export interface LoginInput {
  /** Username or email. */
  identifier: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  /** Printed in the terminal where the server runs when it starts with no account. */
  setupCode: string;
}

export interface EmailLinkRequestInput {
  email: string;
}

/** Always the same answer, whether or not the address belongs to an account. */
export interface EmailLinkRequestView {
  sent: true;
  delivery: 'smtp' | 'console';
}

export interface EmailLinkVerifyInput {
  token: string;
}

// ------------------------------------------------------------------------------------------------ news
// docs/designs/latest-news.md. Display only: no skill reads these, and the impact word changes nothing in the scan.
export type NewsScope = 'shortlist' | 'positions' | 'all';
export type NewsImpact = 'supports' | 'caution' | 'blocks' | 'neutral';
/** F fundamentals, T timing, E events, P open position. */
export type NewsRuleKey = 'f' | 't' | 'e' | 'p';
export type NewsStandingKind = 'sell' | 'open' | 'wait' | 'avoid';
export type NewsSessionId = 'hk_open' | 'us_open' | 'manual';

/** What the app thought of a name at one moment: the recommended put, the open position, or why it waits. */
export interface NewsStandingView {
  kind: NewsStandingKind;
  /** 'Sell', 'Open put', 'Wait (was Sell)', 'Avoid'. */
  label: string;
  /** The contract or the reason, ready to print: '14 Nov · 65 put · 19.4%/yr'. May be empty. */
  detail: string;
  strike: number | null;
  expiry: ISODate | null;
  dte: number | null;
  otmPct: number | null;
}

export interface NewsRuleView {
  key: NewsRuleKey;
  text: string;
}

export interface NewsItemView {
  id: number;
  source: string;
  url: string;
  title: string;
  snippet: string | null;
  /** ISO instant. */
  publishedAt: string;
  /** The Hong Kong calendar day the story belongs to. */
  day: ISODate;
  /** Null = not classified yet: shown without a badge and with "New", never as Neutral. */
  impact: NewsImpact | null;
  /** The one-line "so what" (model-written, rendered as text); null when not classified. */
  summary: string | null;
  rules: NewsRuleView[];
  /** The standing the impact line was written against; null when not classified. */
  standingThen: NewsStandingView | null;
  /** When the model judged it (ISO): the standing above is the one it had then. Null when not classified. */
  judgedAt: string | null;
  confidence: number | null;
  model: string | null;
}

export interface NewsGroupView {
  market: Market;
  symbol: string;
  name: string | null;
  /** Latest close and the day's change in percent. */
  price: number | null;
  changePct: number | null;
  /** The standing now (the card header). */
  standing: NewsStandingView;
  hasOpenPosition: boolean;
  items: NewsItemView[];
}

export interface NewsStatusView {
  /** The newest fetch time of any story, ISO. */
  fetchedAt: string | null;
  /** A fetch, classify or brief run is going now. */
  refreshing: boolean;
  lastFetch: { status: string; finishedAt: string | null; detail: string | null } | null;
  /** Stories waiting for the model (no impact and no failed attempt). */
  unclassified: number;
  ai: {
    available: boolean;
    /** Scheduled jobs may call the model (OT_AI_AUTO is not off). */
    auto: boolean;
    model: string;
    budgetUsd: number;
    spentTodayUsd: number;
  };
  /** The Hong Kong day of the oldest story, so the calendar knows how far back it can go. */
  earliestDay: ISODate | null;
}

export interface NewsView {
  scope: NewsScope;
  /** The day the window ends on (a Hong Kong calendar day). */
  date: ISODate;
  today: ISODate;
  days: number;
  /** Today with a one-day window is the rolling last 24 hours. */
  rolling: boolean;
  hideNeutral: boolean;
  /** Names in each scope, for the segment counts. */
  counts: Record<NewsScope, number>;
  groups: NewsGroupView[];
  /** Names in scope with no story in the window: listed in one quiet row so the user knows they were checked. */
  quiet: { market: Market; symbol: string }[];
  /** Stories shown across the groups. */
  total: number;
  status: NewsStatusView;
}

export interface NewsDayView {
  day: ISODate;
  /** Impact words present that day for the scope (blocks, caution, supports, neutral; 'none' = not classified). */
  impacts: (NewsImpact | 'none')[];
  /** A market brief was written that day. */
  brief: boolean;
}

export interface NewsDaysView {
  month: string;
  scope: NewsScope;
  days: NewsDayView[];
  today: ISODate;
  /** The oldest day with a story or a brief: the month arrows stop here. */
  earliest: ISODate | null;
}

export interface NewsSearchView {
  q: string;
  scope: NewsScope;
  total: number;
  groups: NewsGroupView[];
}

export interface NewsTapeView {
  key: string;
  label: string;
  value: string;
  changePct: number | null;
  asOf: ISODate | null;
}

export interface NewsBulletView {
  tag: 'US' | 'HK·CN' | 'Macro' | 'Dates';
  text: string;
}

export interface NewsCitationView {
  url: string;
  source: string;
  title: string;
  publishedAt: string;
}

export interface NewsBriefView {
  id: number;
  session: NewsSessionId;
  asOf: string;
  lead: string;
  bullets: NewsBulletView[];
  forPuts: string;
  /** Numbers copied from our own tables, never from the model. */
  tape: NewsTapeView[];
  sources: NewsCitationView[];
  model: string | null;
}

export interface NewsBriefDayView {
  date: ISODate;
  briefs: NewsBriefView[];
  /** Why there is none: a weekend, a market holiday, or a day before briefs started. Null when there are briefs. */
  none: 'weekend' | 'holiday' | 'before_start' | 'not_yet' | 'not_written' | null;
  /** The first day a brief was written, for the "briefs started on" note. */
  firstBriefDay: ISODate | null;
}

export interface NewsRefreshView {
  /** False when a refresh was already running. */
  queued: boolean;
  message: string;
}

// ------------------------------------------------------------------------------------------------ endpoint index
// ------------------------------------------------------------------------------------------------ backtests (Phase 4)
// The shapes live with the backtest module (src/backtest/views.ts) so the CLI can use them without importing the server.
export type {
  BacktestDetailView,
  BacktestEquityMetrics,
  BacktestHeadline,
  BacktestMetricsView,
  BacktestRequestInput,
  BacktestStatus,
  BacktestStockCard,
  BacktestSummaryView,
  BacktestTradeSummary,
  BacktestTradeView,
  BacktestWalkForwardView,
  EventStudyView,
  StudyOutcomeView,
  TierPolicy,
} from '../backtest/views';

// ------------------------------------------------------------------------------------------------ daily journal
// A diary entry per user per day (docs/designs/daily-journal.md). The document is ProseMirror JSON in the fixed schema of
// src/journal; the server validates it and derives the Markdown, search text, word count and mentions itself.
export type {
  JournalDocJson,
  JournalMarket,
  JournalMarketView,
  JournalMarkJson,
  JournalNodeJson,
  JournalStatus,
  JournalTemplateId,
} from '../journal/types';

/** A stock name found in an entry. `known` is true when the name exists in the instruments table (it links to Research). */
export interface JournalMentionView {
  market: Market;
  /** Canonical symbol (HK: four digits), as the Research routes expect it. */
  symbol: string;
  /** How it is written: `0700.HK`, `NKE`. */
  label: string;
  known: boolean;
}

/** One row of the entry list: no document, an excerpt instead. */
export interface JournalCardView {
  date: ISODate;
  title: string | null;
  template: JournalTemplateId | null;
  marketView: JournalMarketView;
  tags: string[];
  status: JournalStatus;
  wordCount: number;
  excerpt: string;
  mentions: JournalMentionView[];
  /** Asset id of the first image in the entry, for the card thumbnail (images arrive with stage J2). */
  thumbnailAssetId: string | null;
  /** True when an AI suggestion was ever accepted into this entry. */
  aiPolished: boolean;
  updatedAt: string;
}

export interface JournalSummaryLineView {
  /** `YYYY-MM`. */
  month: string;
  entries: number;
  lessons: number;
  names: number;
  /** Consecutive days with an entry, ending today (or yesterday while today has none). */
  streak: number;
}

export interface JournalListView {
  entries: JournalCardView[];
  total: number;
  page: number;
  pageSize: number;
  summary: JournalSummaryLineView;
}

export interface JournalEntryView extends JournalCardView {
  id: string;
  doc: JournalDocJson;
  markdown: string;
  /** The concurrency token: send it back with the next save. Bumped by every successful write. */
  revisionNo: number;
  createdAt: string;
  revisionCount: number;
  /** The newest accepted AI suggestion, null when there was none. */
  lastAi: { mode: string | null; at: string } | null;
}

export interface JournalEntryInput {
  title: string | null;
  template: JournalTemplateId | null;
  marketView: JournalMarketView;
  tags: string[];
  doc: JournalDocJson;
  /** The `revisionNo` the client loaded; null when it believes the entry does not exist yet. A mismatch answers 409 `revision_conflict`. */
  revisionNo: number | null;
  /** `template` writes a revision of its own (the previous state stays in History). Default `user`. */
  source?: 'user' | 'template';
}

export type JournalRevisionSource = 'user' | 'ai_accepted' | 'restore' | 'template';

export interface JournalRevisionView {
  no: number;
  at: string;
  source: JournalRevisionSource;
  /** "Typed 412 words", "AI · Polish (accepted)", "Restored revision 3". */
  label: string;
  wordCount: number;
  /** True for the newest revision (it matches the entry as it is now). */
  current: boolean;
}

export interface JournalCalendarDayView {
  date: ISODate;
  marketView: JournalMarketView;
  wordCount: number;
  status: JournalStatus;
}

export interface JournalCalendarView {
  month: string;
  days: JournalCalendarDayView[];
  entries: number;
  bullish: number;
  bearish: number;
}

export interface JournalLessonView {
  date: ISODate;
  text: string;
  mentions: JournalMentionView[];
  /** `entry`: a paragraph you wrote that starts with "Lesson:". `ai`: a bullet from an accepted "Lessons & actions" section. */
  source: 'entry' | 'ai';
}

export interface JournalLessonsView {
  lessons: JournalLessonView[];
}

/** One line of "Your notes" on a stock's Research page. */
export interface JournalNoteView {
  date: ISODate;
  title: string | null;
  marketView: JournalMarketView;
  /** The line of the entry that names the stock, as plain text. */
  snippet: string;
}

export interface JournalNotesView {
  /** The user's newest entries that mention the stock (at most three), newest first. */
  entries: JournalNoteView[];
}

/** A stored image: `url` is what a figure's `<img>` loads (same origin, signed-in users only). */
export interface JournalAssetView {
  id: string;
  url: string;
  width: number;
  height: number;
}

// ---- AI rewrite (docs/designs/daily-journal.md): a suggestion with a diff; nothing changes until the author accepts
export type JournalAiMode = 'polish' | 'tighten' | 'structure' | 'lessons' | 'translate_zh' | 'translate_en' | 'custom';

export interface JournalAiStartInput {
  mode: JournalAiMode;
  /** The author's own wish, at most 500 characters. Required for `custom`. */
  instruction?: string | null;
  /** Give the model today's open positions and scan picks as reference (off by default). */
  withContext?: boolean;
}

export interface JournalAiStartView {
  runId: string;
}

export type JournalAiStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JournalAiRunView {
  id: string;
  date: ISODate;
  mode: JournalAiMode;
  instruction: string | null;
  withContext: boolean;
  status: JournalAiStatus;
  /** null until the author decides; true after Use suggestion, false after Keep mine. */
  accepted: boolean | null;
  /** The run's own lines, in order ("prose: 412 words, 3 locked blocks ...", "writing..."). */
  progress: string[];
  /** Why a run failed or a suggestion was refused, in words for the author. */
  error: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** Present when `status` is `done`. */
  result: {
    /** The whole entry as it would become, with images, tables, snapshots and checklists put back untouched. */
    doc: JournalDocJson;
    /** What the model was given and what it returned, for the word diff. Locked blocks appear as `[[FIG:1]]` lines. */
    inputMarkdown: string;
    outputMarkdown: string;
    lockedKept: number;
    lockedTotal: number;
  } | null;
}

export interface JournalAiAcceptView {
  entry: JournalEntryView;
  /** The revision holding the entry as it was before the suggestion: Undo restores it. */
  undoRevisionNo: number | null;
}

/** A frozen copy of app data as a table, the content of a `snapshot` node. */
export interface JournalSnapshotView {
  kind: 'positions' | 'scan';
  asOf: string;
  title: string;
  columns: string[];
  align: ('l' | 'r')[];
  rows: string[][];
}

/**
 * GET    /api/health                                   -> HealthView   (public; without a session only { ok: true })
 * GET    /api/auth/session                             -> AuthSessionView   (public)
 * POST   /api/auth/login                               body LoginInput -> AuthUserView   (sets the session cookie; 401 invalid_credentials, 429 too_many_attempts)
 * POST   /api/auth/register                            body RegisterInput -> AuthUserView   (first account only: from the server's own machine with the setup code from its terminal; 403 signup_closed, setup_local_only, invalid_setup_code)
 * POST   /api/auth/email/request                       body EmailLinkRequestInput -> EmailLinkRequestView
 * POST   /api/auth/email/verify                        body EmailLinkVerifyInput -> AuthUserView   (401 invalid_link)
 * POST   /api/auth/logout                              -> { ok: true }
 * GET    /api/auth/google/start                        -> 302 to Google (a browser navigation, not a fetch)
 * GET    /api/auth/google/callback                     -> 302 to /#/today, or to /#/login?error=<code>
 * Every other /api endpoint answers 401 `unauthenticated` without a valid session cookie (unless the server runs with OT_AUTH=off).
 * GET    /api/overview                                 -> OverviewView
 * GET    /api/scan?allowStale=1&asOf=YYYY-MM-DD        -> ScanView        (runs the pipeline, reads the database only; asOf replays a past session)
 * POST   /api/scan/run                                 -> ScanView        (same, and stores the run)
 * GET    /api/stocks/:market/:symbol/explain           -> ExplainView     (every scanner skill, even after a FAIL)
 * GET    /api/stocks/:market/:symbol/chart?bars=180    -> ChartView
 * GET    /api/stocks/:market/:symbol/value?rate=8      -> ValueView       (KPIs, quality screen, intrinsic value)
 * PUT    /api/stocks/:market/:symbol/valuation         body ValuationOverrides | null  -> ValueView
 * GET    /api/watchlist                                -> WatchEntryView[]
 * GET    /api/watchlist/board                          -> WatchBoardView  (watched names with price, KPIs, highlights, recommendation)
 * GET    /api/watchlist/preview?raw=&market=           -> WatchPreviewView
 * POST   /api/watchlist                                body WatchAddInput -> WatchEntryView
 * PATCH  /api/watchlist/:market/:symbol                body WatchPatch -> WatchEntryView
 * POST   /api/watchlist/bulk                           body WatchBulkInput -> WatchEntryView[]
 * POST   /api/watchlist/paste                          body { text: string; apply: boolean } -> WatchPasteView
 * GET    /api/watchlist/export.csv                     -> text/csv
 * GET    /api/positions                                -> PositionsView
 * POST   /api/positions                                body PositionAddInput -> PositionView
 * POST   /api/positions/:id/close                      body PositionCloseInput -> PositionView
 * POST   /api/positions/marks/run                      body { asOf?: YYYY-MM-DD } -> MarkRunView   (marks every open put now and stores the rows)
 * GET    /api/lots?status=open|sold                    -> LotView[]       (shares received when a put is assigned)
 * POST   /api/lots/:id/sell                            body LotSellInput -> LotView
 * POST   /api/backtests                                body BacktestRequestInput -> BacktestSummaryView   (starts a background run)
 * GET    /api/backtests                                -> BacktestSummaryView[]  (newest first)
 * GET    /api/backtests/:id                            -> BacktestDetailView
 * GET    /api/backtests/:id/trades?shadow=1            -> BacktestTradeView[]
 * GET    /api/backtests/:id/trades.csv                 -> text/csv
 * POST   /api/backtests/:id/cancel                     -> BacktestSummaryView
 * GET    /api/stocks/:market/:symbol/studies           -> EventStudyView   (what each entry rule has historically done)
 * POST   /api/journal/import                           body JournalImportInput -> JournalImportView
 * GET    /api/journal/entries?from=&to=&q=&symbol=&tag=&page=&today=  -> JournalListView   (the signed-in user's entries, newest first; `today` is the client's date, for the streak)
 * GET    /api/journal/entries/:date                    -> JournalEntryView   (404 entry_not_found)
 * PUT    /api/journal/entries/:date                    body JournalEntryInput -> JournalEntryView   (creates or updates; 400 invalid_document; 409 revision_conflict with details { currentRevisionNo })
 * POST   /api/journal/entries/:date/close              (?reopen=1 to reopen) -> JournalEntryView
 * DELETE /api/journal/entries/:date                    -> { ok: true }   (soft delete: hidden, kept 30 days)
 * POST   /api/journal/entries/:date/undelete           -> JournalEntryView   (the Undo of a delete)
 * GET    /api/journal/entries/:date/revisions          -> JournalRevisionView[]  (newest first)
 * POST   /api/journal/entries/:date/revisions/:no/restore  -> JournalEntryView   (appends a new revision; nothing is deleted)
 * GET    /api/journal/entries/:date/export.md          -> text/markdown
 * GET    /api/journal/calendar?month=YYYY-MM           -> JournalCalendarView
 * GET    /api/journal/lessons?limit=                   -> JournalLessonsView
 * POST   /api/journal/assets                           multipart/form-data with one image field -> JournalAssetView   (201; 413 file_too_large, 415 unsupported_image; re-encoded, EXIF stripped, long edge 2000 px)
 * GET    /api/journal/assets/:id?thumb=1               -> the image (signed-in owner only; Cache-Control private; thumb = 320 px WebP)
 * DELETE /api/journal/assets/:id                       -> { ok: true }   (409 asset_in_use while an entry or revision shows it)
 * POST   /api/journal/entries/:date/ai                 body JournalAiStartInput -> JournalAiStartView   (202; 409 run_in_progress with details { runId }; 429 daily_limit; 503 ai_unavailable)
 * GET    /api/journal/entries/:date/ai                 -> JournalAiRunView | null   (the newest run of the entry, so a suggestion that waited can be found again)
 * GET    /api/journal/ai/:runId                        -> JournalAiRunView
 * POST   /api/journal/ai/:runId/cancel                 -> JournalAiRunView
 * POST   /api/journal/ai/:runId/accept                 -> JournalAiAcceptView   (replaces the entry, writes a revision; 409 entry_changed when the entry was edited after the run started)
 * POST   /api/journal/ai/:runId/reject                 -> JournalAiRunView
 * GET    /api/journal/snapshot?kind=positions|scan     -> JournalSnapshotView
 * GET    /api/stocks/:market/:symbol/journal           -> JournalNotesView   (the signed-in user's newest entries that mention the stock; the Research "Your notes" card)
 * GET    /api/settings                                 -> SettingsView
 * PUT    /api/settings                                 body SettingsPatch -> SettingsView
 * GET    /api/data/status                              -> DataStatusView
 * POST   /api/ingest                                   body IngestStartInput -> IngestJobView   (409 ingest_running with details { id } if one is running)
 * GET    /api/ingest/:id                               -> IngestJobView
 * POST   /api/chains/import                            body ChainImportInput -> ChainImportView
 * POST   /api/events                                   body EventAddInput -> { ok: true }
 * POST   /api/fair-values/import                       body FairValueImportInput -> FairValueImportView
 * GET    /api/news?scope=&date=&days=1|3|7|30&neutral=0|1  -> NewsView   (stories on the shortlist, positions or all watched names; date defaults to today; neutral=0 hides Neutral stories)
 * GET    /api/news/days?month=YYYY-MM&scope=           -> NewsDaysView   (calendar dots)
 * GET    /api/news/search?q=&scope=                    -> NewsSearchView   (all days)
 * GET    /api/news/brief?date=YYYY-MM-DD               -> NewsBriefDayView   (every session written that day)
 * POST   /api/news/refresh                             -> NewsRefreshView   (queues fetch, classify and brief; 202)
 * GET    /api/leaders?date=&stage=&market=&state=      -> LeadersView   (the combined list of the latest run of each market; date renders an archived day from the stored rows; stage lists the names that stopped there)
 * GET    /api/leaders/days?month=YYYY-MM               -> LeadersDaysView   (calendar dots)
 * GET    /api/leaders/record?window=60|all             -> LeaderRecordView
 * POST   /api/leaders/refresh                          -> LeadersRefreshView   (queues the scan for both markets; 30-minute debounce; 202)
 * POST   /api/leaders/candidates/:id/mute              body LeaderMuteInput -> LeaderMuteView   (default 10 trading days)
 * DELETE /api/leaders/candidates/:id/mute              -> { ok: true }
 * POST   /api/leaders/candidates/:id/watch             -> LeaderWatchView   (adds the instrument to the watchlist)
 * GET    /api/reminders?days=30                         -> RemindersView
 * GET    /api/skills                                   -> SkillCatalogView
 * POST   /api/research/runs                            body ResearchStartInput -> ResearchRunView[]
 * GET    /api/research/runs?market=&symbol=            -> ResearchRunView[]  (newest first)
 * GET    /api/research/runs/:id                        -> ResearchRunDetailView
 * POST   /api/research/runs/:id/cancel                 -> ResearchRunView
 * GET    /api/research/runs/:id/report.md              -> text/markdown
 * POST   /api/ask                                      body AskStartInput -> AskItemView   (202; one question, queued)
 * GET    /api/ask?kind=idea&market=&symbol=            -> AskThreadView   (every question asked about that idea, oldest first)
 * GET    /api/ask?kind=position&positionId=            -> AskThreadView
 * GET    /api/ask/:id                                  -> AskItemView   (poll while queued or running)
 */
export const API_PREFIX = '/api';
