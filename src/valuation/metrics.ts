/**
 * Per-year ratios and multi-year aggregates over `Facts.annual`, shared by the KPI table, the quality screen and the
 * intrinsic-value defaults, so one definition feeds all three. Ratios use statement-currency money (no FX); only
 * growth rates across years go through `comparable` (a no-op unless the statements switch reporting currency).
 */
import { defaultParams } from '../core/params';
import { round } from '../core/util';
import { isNum, lastN, mean, type Point, pointsCagr } from './math';
import type { AnnualFact, Facts } from './types';

// Constants shared with the scanner's fundamental gate (S1): the same defaults, not a second copy of the numbers.
const GATE = defaultParams()['fundamental.gate'];
/** NOPAT = EBIT x (1 - rate); statements carry no tax line. */
export const ROIC_TAX_RATE = GATE.roicTaxRate;
export const FCF_YIELD_MIN_PCT = round(GATE.fcfYieldMin * 100, 6);
export const NET_DEBT_EBITDA_MAX = GATE.netDebtEbitdaMax;
export const F_SCORE_MIN = GATE.fScoreMin;
export const Z_PASS = GATE.zPass;
export const Z_WARN = GATE.zWarn;

/** Years of statements the 5-year and 10-year rules want. */
export const NEED_5Y = 5;
export const NEED_10Y = 10;
/** A 5-year growth rate or change is measured over the last six statements: five yearly steps. */
export const GROWTH_STATEMENTS = 6;

export const windowTag = (have: number, need: number): string | null => (have < need ? `${have}y of ${need}y` : null);

// ------------------------------------------------------------------------------------------------- yearly ratios
const pctOf = (n: number | null, d: number | null): number | null =>
  n !== null && d !== null && d > 0 ? (n / d) * 100 : null;

export const ebitOf = (a: AnnualFact): number | null => a.ebit ?? a.operatingIncome;

/** Return on year-end equity; undefined (null) for zero or negative equity. */
export const roeYear = (a: AnnualFact): number | null => pctOf(a.netIncome, a.totalEquity);

/** After-tax EBIT over invested capital (equity + debt - cash), the formula of the S1 gate. */
export function roicYear(a: AnnualFact): number | null {
  const ebit = ebitOf(a);
  if (ebit === null || a.totalEquity === null || a.totalDebt === null || a.cash === null) return null;
  const capital = a.totalEquity + a.totalDebt - a.cash;
  return capital > 0 ? ((ebit * (1 - ROIC_TAX_RATE)) / capital) * 100 : null;
}

export const grossMarginYear = (a: AnnualFact): number | null => pctOf(a.grossProfit, a.revenue);
export const operatingMarginYear = (a: AnnualFact): number | null => pctOf(a.operatingIncome ?? a.ebit, a.revenue);
export const netMarginYear = (a: AnnualFact): number | null => pctOf(a.netIncome, a.revenue);
export const capexRevenueYear = (a: AnnualFact): number | null => pctOf(a.capex, a.revenue);

/** Operating cash flow over net income; years with a loss are skipped (the ratio of two negatives means nothing). */
export const ocfNiYear = (a: AnnualFact): number | null =>
  a.cfo !== null && a.netIncome !== null && a.netIncome > 0 ? a.cfo / a.netIncome : null;

export function interestCoverYear(a: AnnualFact): number | null {
  const ebit = ebitOf(a);
  return ebit !== null && a.interestExpense !== null && a.interestExpense > 0 ? ebit / a.interestExpense : null;
}

/** (debt - cash) / EBITDA; undefined for EBITDA <= 0 (the caller decides what that means). */
export const netDebtEbitdaYear = (a: AnnualFact): number | null =>
  a.totalDebt !== null && a.cash !== null && a.ebitda !== null && a.ebitda > 0
    ? (a.totalDebt - a.cash) / a.ebitda
    : null;

export const debtNiYear = (a: AnnualFact): number | null =>
  a.totalDebt !== null && a.netIncome !== null && a.netIncome > 0 ? a.totalDebt / a.netIncome : null;

export const payoutYear = (a: AnnualFact): number | null => pctOf(a.dividendsPaid, a.netIncome);

// ------------------------------------------------------------------------------------------------- aggregates
/** Mean of a yearly ratio over the last `years` statements, ignoring years where it is undefined. */
export function avgOver(
  facts: Facts,
  years: number,
  f: (a: AnnualFact) => number | null,
): { value: number | null; used: number } {
  const vals = lastN(facts.annual, years).map(f).filter(isNum);
  return { value: mean(vals), used: vals.length };
}

/** The yearly values of `f` over the last `count` statements, oldest first (undefined years dropped). */
export function yearlyValues(facts: Facts, count: number, f: (a: AnnualFact) => number | null): number[] {
  return lastN(facts.annual, count).map(f).filter(isNum);
}

/** A money amount comparable across years: as reported when all years share a currency, else converted at the latest rate. */
export function comparable(facts: Facts, a: AnnualFact, v: number | null): number | null {
  if (v === null) return null;
  if (!facts.mixedCurrency) return v;
  return a.fx === null ? null : v * a.fx;
}

/** Points of a comparable series over the last `count` statements (undefined years dropped). */
export function seriesPoints(facts: Facts, count: number, pick: (a: AnnualFact) => number | null): Point[] {
  const pts: Point[] = [];
  for (const a of lastN(facts.annual, count)) {
    const v = comparable(facts, a, pick(a));
    if (v !== null) pts.push({ periodEnd: a.periodEnd, value: v });
  }
  return pts;
}

/** Revenue CAGR over exactly three years (needs four statements with revenue at both ends), percent. */
export function revenueCagr3(facts: Facts): number | null {
  if (facts.annual.length < 4) return null;
  const slice = lastN(facts.annual, 4);
  const first = slice[0] as AnnualFact;
  const last = slice[slice.length - 1] as AnnualFact;
  const a = comparable(facts, first, first.revenue);
  const b = comparable(facts, last, last.revenue);
  if (a === null || b === null) return null;
  return pointsCagr([
    { periodEnd: first.periodEnd, value: a },
    { periodEnd: last.periodEnd, value: b },
  ]).pct;
}

/** Revenue CAGR over up to five years (all available when fewer), with the span it used, percent. */
export function revenueCagr5(facts: Facts): { pct: number | null; years: number } {
  return pointsCagr(seriesPoints(facts, GROWTH_STATEMENTS, (a) => a.revenue));
}

/** EPS CAGR over up to five years. Undefined (null) when either end is not positive. */
export function epsCagr5(facts: Facts): { pct: number | null; years: number } {
  return pointsCagr(seriesPoints(facts, GROWTH_STATEMENTS, (a) => a.epsStmt));
}

/** Free-cash-flow-per-share CAGR over up to five years. */
export function fcfPsCagr5(facts: Facts): { pct: number | null; years: number } {
  return pointsCagr(seriesPoints(facts, GROWTH_STATEMENTS, (a) => a.fcfPsStmt));
}

/** Change of the diluted share count over up to five years, percent (negative = buybacks). */
export function dilutionPct(facts: Facts): number | null {
  const shares = lastN(facts.annual, GROWTH_STATEMENTS)
    .map((a) => a.sharesDiluted)
    .filter(isNum);
  if (shares.length < 2) return null;
  const first = shares[0] as number;
  const last = shares[shares.length - 1] as number;
  return first > 0 ? (last / first - 1) * 100 : null;
}

/** Free cash flow added up over the last five statements; `used` = statements that had a figure. */
export function cumulativeFcf(facts: Facts): { sum: number | null; used: number } {
  let sum = 0;
  let used = 0;
  for (const a of lastN(facts.annual, NEED_5Y)) {
    const v = comparable(facts, a, a.fcf);
    if (v !== null) {
      sum += v;
      used++;
    }
  }
  return used === 0 ? { sum: null, used: 0 } : { sum, used };
}

/** Year-end P/E points (positive EPS only), oldest first. */
export function peHistory(facts: Facts): number[] {
  return facts.annual.map((a) => a.yearEndPe).filter(isNum);
}
