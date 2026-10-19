/**
 * Types of the valuation module. The OUTPUT shapes (KpiRowView ... ValuationOverrides) are structural copies of the
 * HTTP contract in src/server/api-types.ts: this module may not import from the server, and
 * tests/valuation/contract.test.ts proves at compile time that the two sets stay assignable in both directions.
 * Percent fields are percentages (5.0 = 5%); `ratio` fields are fractions (0.93 = 93%).
 */
import type { Currency, DailyBar, FundamentalStatement, ISODate, Market, SolvencyModel } from '../core/types';

// ---------------------------------------------------------------------------------------------------- output shapes
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

/** Per-stock overrides of the valuation assumptions; any field may be omitted. Triples are ordered [bull, base, bear]. */
export interface ValuationOverrides {
  growthPct?: [number, number, number];
  targetPe?: [number, number, number];
  dcfGrowthPct?: number;
  requiredReturnPct?: number;
}

// ---------------------------------------------------------------------------------------------------------- input
export interface ValuationInput {
  symbol: string;
  market: Market;
  /** Trading currency of the price. */
  currency: Currency;
  solvencyModel: SolvencyModel;
  asOf: ISODate;
  /** Last close, trading currency. */
  price: number;
  /** Ascending, <= asOf. Used for year-end prices (P/E history) and the listing-age proxy. */
  bars: DailyBar[];
  /** Any period type, already point-in-time filtered by the caller. 'ttm' rows are ignored. */
  statements: FundamentalStatement[];
  /** 1 unit of `ccy` in trading currency; 1 for the trading currency itself; null if unknown. */
  fxToTrading(ccy: string): number | null;
  /** Values computed elsewhere (scanner skill S1) that this module cannot derive from the statements alone. */
  extras?: { altmanZ?: number | null; fScore?: number | null; netDebtEbitda?: number | null };
  /** Latest imported Morningstar fair value, in trading currency. */
  fairValue?: { value: number; asOf: string; moat: string | null; uncertainty: string | null; source: string } | null;
}

// ----------------------------------------------------------------------------------------------------------- facts
/**
 * One fiscal year, normalised. Money fields are in the STATEMENT currency (`currency`), so margins, ROE and other
 * ratios need no FX; `fx` converts the statement currency to the trading currency (latest rate for every year) and the
 * per-share fields are already in TRADING currency (null when `fx` is unknown). Cash outflows (`capex`,
 * `dividendsPaid`, `buybacks`) are stored as positive magnitudes whatever sign the provider used.
 */
export interface AnnualFact {
  periodEnd: ISODate;
  /** Calendar year of `periodEnd`. */
  year: number;
  /** Currency the statement was reported in. */
  currency: string;
  /** 1 unit of `currency` in trading currency; null when no rate is known. */
  fx: number | null;
  /** True when built by adding two semiannual statements. */
  fromHalves: boolean;

  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebit: number | null;
  ebitda: number | null;
  interestExpense: number | null;
  netIncome: number | null;
  sharesDiluted: number | null;
  totalDebt: number | null;
  cash: number | null;
  totalEquity: number | null;
  cfo: number | null;
  capex: number | null;
  /** Reported free cash flow, else operating cash flow minus capex. */
  fcf: number | null;
  dividendsPaid: number | null;
  buybacks: number | null;

  /** Diluted EPS in the statement currency (reported, else net income / diluted shares). */
  epsStmt: number | null;
  /** Per-share values in the statement currency. */
  dpsStmt: number | null;
  fcfPsStmt: number | null;
  bvpsStmt: number | null;

  /** Per-share values in the TRADING currency (statement value x fx); null when fx is unknown or the input is missing. */
  eps: number | null;
  dps: number | null;
  fcfPs: number | null;
  bvps: number | null;

  /** Last close on or before `periodEnd` (within 10 days), trading currency. */
  yearEndPrice: number | null;
  /** yearEndPrice / eps, only when eps > 0. */
  yearEndPe: number | null;
}

/** One quarterly (or, for semiannual reporters, half-yearly) statement, reduced to what the quarter table shows. */
export interface SubPeriodFact {
  periodEnd: ISODate;
  kind: 'quarterly' | 'semiannual';
  currency: string;
  revenue: number | null;
  grossProfit: number | null;
}

export interface Facts {
  symbol: string;
  market: Market;
  currency: Currency;
  solvencyModel: SolvencyModel;
  asOf: ISODate;
  /** Last close in trading currency; 0 when the input was not a positive finite number (a warning says so). */
  price: number;
  /** One entry per fiscal year, ascending by periodEnd. */
  annual: AnnualFact[];
  /** The latest entry of `annual`, or null. */
  latest: AnnualFact | null;
  /** True when `annual` was built from semiannual statements (the name has no annual ones). */
  annualFromHalves: boolean;
  /** True when the annual statements are reported in more than one currency. */
  mixedCurrency: boolean;
  /** Quarterly statements, ascending (the last 8 are kept); semiannual ones when there are no quarterly statements. */
  subPeriods: SubPeriodFact[];
  /** Years spanned by `bars` (last day - first day); null with no bars. Bars are capped at 10 years upstream. */
  barsSpanYears: number | null;
  extras: { altmanZ: number | null; fScore: number | null; netDebtEbitda: number | null };
  fairValue: { value: number; asOf: string; moat: string | null; uncertainty: string | null; source: string } | null;
  /** Data limitations found while normalising (missing FX rates, unpaired half-years, mixed currencies, ...). */
  warnings: string[];
}
