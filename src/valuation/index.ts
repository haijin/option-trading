/**
 * Valuation: KPIs, the 7-filter quality screen and intrinsic value from stored statements. Pure functions over plain
 * inputs (same inputs, same outputs): no clock, no database, no network. The server builds `ValuationInput` from the
 * database and serialises the views as they are.
 *
 *   buildFacts(input) -> Facts          normalised annual series, converted per-share figures, warnings
 *   kpiRows(facts)                      the KPI table (25 rows, fixed order)
 *   quarterRows(facts)                  the last four quarters
 *   qualityScreen(facts)                the 7 filters and 3 exemptions
 *   defaultAssumptions(facts, ...)      what the valuation would assume, with sources
 *   intrinsicValue(facts, opts)         scenario, DCF, reverse DCF, fair value, stars
 *   priceBadge(iv)                      the compact figures for lists
 */
export { buildFacts } from './facts';
export {
  dcfValue,
  defaultAssumptions,
  impliedGrowth,
  intrinsicValue,
  priceBadge,
  scenarioValue,
  starsFor,
} from './intrinsic';
export { kpiRows, quarterRows } from './kpi';
export { qualityScreen } from './screen';
export type {
  AnnualFact,
  AssumptionParam,
  AssumptionsView,
  Facts,
  IntrinsicView,
  KpiGroup,
  KpiRowView,
  MethodView,
  QuarterRowView,
  ScenarioView,
  ScreenRowView,
  ScreenView,
  SubPeriodFact,
  ValuationInput,
  ValuationOverrides,
} from './types';
