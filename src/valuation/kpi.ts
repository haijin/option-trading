/**
 * The KPI table (design doc "KPIs and quality screen") and the last-quarters table, from `Facts`.
 *
 * Every row has a value or, when an input is missing, a null value with status 'info': nothing is invented and nothing
 * is NaN. Rules and thresholds are the prototype's (and, where the scanner has the same test, the scanner's constants).
 * Values are rounded to 6 decimals before they are compared with a threshold, so a value that is exactly 15 in decimal
 * arithmetic is not 14.999999999999998 here. Rows that need statements the data does not hold carry a `window` tag.
 */
import { diffDays } from '../core/dates';
import { median } from '../core/util';
import { isNum, lastN, ordinal, percentRank, r6 } from './math';
import {
  avgOver,
  capexRevenueYear,
  debtNiYear,
  dilutionPct,
  ebitOf,
  epsCagr5,
  F_SCORE_MIN,
  FCF_YIELD_MIN_PCT,
  grossMarginYear,
  interestCoverYear,
  NEED_5Y,
  NEED_10Y,
  NET_DEBT_EBITDA_MAX,
  netDebtEbitdaYear,
  netMarginYear,
  ocfNiYear,
  operatingMarginYear,
  payoutYear,
  peHistory,
  revenueCagr3,
  revenueCagr5,
  roeYear,
  roicYear,
  seriesPoints,
  windowTag,
  yearlyValues,
  Z_PASS,
  Z_WARN,
} from './metrics';
import type { AnnualFact, Facts, KpiGroup, KpiRowView, QuarterRowView } from './types';

type Status = KpiRowView['status'];
type RowExtra = Partial<Pick<KpiRowView, 'value' | 'text' | 'status' | 'trend' | 'window'>>;

function row(
  group: KpiGroup,
  key: string,
  label: string,
  unit: KpiRowView['unit'],
  rule: string,
  x: RowExtra = {},
): KpiRowView {
  return {
    group,
    key,
    label,
    value: x.value ?? null,
    unit,
    text: x.text ?? null,
    status: x.status ?? 'info',
    rule,
    trend: x.trend ?? null,
    window: x.window ?? null,
  };
}

/** Value (rounded) and status for a number that may be missing; 'info' when it is, or when there is no grading rule. */
function graded(raw: number | null, grade?: (v: number) => Status): { value: number | null; status: Status } {
  if (raw === null || !Number.isFinite(raw)) return { value: null, status: 'info' };
  const value = r6(raw);
  return { value, status: grade ? grade(value) : 'info' };
}

const atLeast =
  (ok: number, warn: number) =>
  (v: number): Status =>
    v >= ok ? 'ok' : v >= warn ? 'warn' : 'fail';
const atMost =
  (ok: number, warn: number) =>
  (v: number): Status =>
    v <= ok ? 'ok' : v <= warn ? 'warn' : 'fail';

/** Up to five yearly values, oldest first; null with fewer than two. */
function trendOf(values: number[]): number[] | null {
  const v = lastN(values, 5).map(r6);
  return v.length >= 2 ? v : null;
}

const NO_FX = 'no FX rate';
const NOT_FOR_FINANCIALS = 'not used for banks and insurers';

export function kpiRows(facts: Facts): KpiRowView[] {
  const A = facts.annual;
  const n = A.length;
  const L = facts.latest;
  const price = facts.price;
  const hasPrice = price > 0;
  const fin = facts.solvencyModel === 'financial';
  const noFx = L !== null && L.fx === null;
  const yearly = (f: (a: AnnualFact) => number | null): number[] | null => trendOf(yearlyValues(facts, 5, f));
  const levels = (pick: (a: AnnualFact) => number | null): number[] | null =>
    trendOf(seriesPoints(facts, 5, pick).map((p) => p.value));
  const rows: KpiRowView[] = [];

  // ------------------------------------------------------------------------------------------------ profitability
  const roe5 = avgOver(facts, 5, roeYear);
  rows.push(
    row('Profitability', 'roe5', 'ROE, 5-year average', '%', '> 15 good, > 20 great', {
      ...graded(roe5.value, atLeast(15, 8)),
      trend: yearly(roeYear),
      window: windowTag(n, NEED_5Y),
    }),
  );
  const roe10 = avgOver(facts, 10, roeYear);
  rows.push(
    row('Profitability', 'roe10', 'ROE, 10-year average', '%', 'screen filter 1: >= 8%', {
      ...graded(roe10.value, atLeast(8.8, 8)),
      trend: yearly(roeYear),
      window: windowTag(n, NEED_10Y),
    }),
  );
  rows.push(
    row(
      'Profitability',
      'roic',
      'Return on invested capital',
      '%',
      'context only; after-tax EBIT / (equity + debt - cash), median',
      {
        ...graded(fin ? null : median(yearlyValues(facts, 5, roicYear))),
        text: fin ? NOT_FOR_FINANCIALS : null,
        trend: fin ? null : yearly(roicYear),
        window: fin ? null : windowTag(n, NEED_5Y),
      },
    ),
  );
  const gm = avgOver(facts, 5, grossMarginYear);
  rows.push(
    row('Profitability', 'gross_margin', 'Gross margin, long-run', '%', '> 40 pricing power; >= 15 (screen 4)', {
      ...graded(fin ? null : gm.value, atLeast(40, 15)),
      text: fin ? 'not defined for banks and insurers' : null,
      trend: fin ? null : yearly(grossMarginYear),
      window: fin ? null : windowTag(n, NEED_5Y),
    }),
  );
  rows.push(
    row('Profitability', 'operating_margin', 'Operating margin', '%', 'context only', {
      ...graded(L ? operatingMarginYear(L) : null),
      trend: yearly(operatingMarginYear),
    }),
  );
  const nm = avgOver(facts, 10, netMarginYear);
  rows.push(
    row('Profitability', 'net_margin', 'Net margin, long-run', '%', 'screen filter 6: >= 5%', {
      ...graded(nm.value, atLeast(5.5, 5)),
      trend: yearly(netMarginYear),
      window: windowTag(n, NEED_10Y),
    }),
  );

  // ------------------------------------------------------------------------------------------------- cash quality
  const fcfYield = (a: AnnualFact, px: number): number | null =>
    a.fcfPs !== null && px > 0 ? (a.fcfPs / px) * 100 : null;
  rows.push(
    row('Cash quality', 'fcf_yield', 'Free-cash-flow yield', '%', `scan gate >= ${FCF_YIELD_MIN_PCT}%`, {
      ...graded(L ? fcfYield(L, price) : null, (v) => (v >= FCF_YIELD_MIN_PCT ? 'ok' : 'fail')),
      text: noFx ? NO_FX : null,
      trend: yearly((a) => fcfYield(a, price)),
    }),
  );
  const ocf = avgOver(facts, 5, ocfNiYear);
  rows.push(
    row('Cash quality', 'ocf_ni', 'Operating cash flow / net income', 'x', 'screen filter 5: >= 0.7', {
      ...graded(ocf.value, atLeast(0.77, 0.7)),
      trend: yearly(ocfNiYear),
      window: windowTag(n, NEED_5Y),
    }),
  );
  rows.push(
    row('Cash quality', 'capex_revenue', 'Capex / revenue', '%', 'context only; lighter is better', {
      ...graded(L ? capexRevenueYear(L) : null),
      trend: yearly(capexRevenueYear),
    }),
  );

  // ----------------------------------------------------------------------------------------------------- safety
  rows.push(interestCoverRow(facts, fin));
  rows.push(netDebtRow(facts, fin));
  rows.push(debtNiRow(facts, fin));
  const z = facts.extras.altmanZ;
  rows.push(
    row('Safety', 'altman_z', 'Altman Z', 'num', `> ${Z_PASS} pass, ${Z_WARN} to ${Z_PASS} warn`, {
      ...graded(z, (v) => (v > Z_PASS ? 'ok' : v > Z_WARN ? 'warn' : 'fail')),
    }),
  );
  const f = facts.extras.fScore;
  rows.push(
    row('Safety', 'f_score', 'Piotroski F-score', 'text', `>= ${F_SCORE_MIN} of 9`, {
      ...graded(f, (v) => (v >= F_SCORE_MIN ? 'ok' : 'fail')),
      text: f === null ? null : `${f} / 9`,
    }),
  );

  // ---------------------------------------------------------------------------------------------------- growth
  rows.push(
    row('Growth', 'revenue_cagr3', 'Revenue CAGR, 3-year', '%', '>= 0%', {
      ...graded(revenueCagr3(facts), (v) => (v >= 0 ? 'ok' : 'warn')),
      trend: levels((a) => a.revenue),
      window: windowTag(n, 4),
    }),
  );
  rows.push(
    row('Growth', 'revenue_cagr5', 'Revenue CAGR, 5-year', '%', 'context only', {
      ...graded(revenueCagr5(facts).pct),
      trend: levels((a) => a.revenue),
      window: windowTag(n, NEED_5Y),
    }),
  );
  const ec = epsCagr5(facts).pct;
  rows.push(
    row('Growth', 'eps_cagr5', 'EPS CAGR, 5-year', '%', 'context only', {
      ...graded(ec, (v) => (v < 0 ? 'warn' : 'info')),
      text: ec === null && n >= 2 ? 'needs positive EPS at both ends' : null,
      trend: levels((a) => a.epsStmt),
      window: windowTag(n, NEED_5Y),
    }),
  );
  rows.push(
    row(
      'Growth',
      'dilution',
      'Share count change over the window',
      '%',
      'screen filter 7: <= 20%; negative = buybacks',
      {
        ...graded(dilutionPct(facts), atMost(18, 20)),
        trend: yearly((a) => a.sharesDiluted),
        window: windowTag(n, NEED_5Y),
      },
    ),
  );

  // ------------------------------------------------------------------------------------------------- valuation
  rows.push(peRow(facts));
  const eps = L?.eps ?? null;
  const fcfPs = L?.fcfPs ?? null;
  const bvps = L?.bvps ?? null;
  const dps = L?.dps ?? null;
  const yePrice = (a: AnnualFact): number | null => a.yearEndPrice;
  const atYearEnd = (a: AnnualFact, num: number | null, den: number | null): number | null => {
    const px = yePrice(a);
    return px !== null && num !== null && den !== null && den > 0 ? (num / den) * px : null;
  };
  rows.push(
    row('Valuation', 'pb', 'P/B', 'x', 'context only', {
      ...graded(hasPrice && bvps !== null && bvps > 0 ? price / bvps : null),
      text: noFx ? NO_FX : bvps !== null && bvps <= 0 ? 'negative book value' : null,
      trend: yearly((a) => atYearEnd(a, 1, a.bvps)),
    }),
  );
  rows.push(
    row('Valuation', 'p_fcf', 'Price / free cash flow', 'x', 'context only', {
      ...graded(hasPrice && fcfPs !== null && fcfPs > 0 ? price / fcfPs : null),
      text: noFx ? NO_FX : fcfPs !== null && fcfPs <= 0 ? 'free cash flow not positive' : null,
      trend: yearly((a) => atYearEnd(a, 1, a.fcfPs)),
    }),
  );
  rows.push(
    row('Valuation', 'dividend_yield', 'Dividend yield', '%', 'context only', {
      ...graded(hasPrice && dps !== null ? (dps / price) * 100 : null),
      text: noFx ? NO_FX : null,
      trend: yearly((a) => (a.dps !== null && a.yearEndPrice !== null ? (a.dps / a.yearEndPrice) * 100 : null)),
    }),
  );
  rows.push(
    row('Valuation', 'earnings_yield', 'Earnings yield', '%', 'context only', {
      ...graded(hasPrice && eps !== null ? (eps / price) * 100 : null),
      text: noFx ? NO_FX : null,
      trend: yearly((a) => (a.eps !== null && a.yearEndPrice !== null ? (a.eps / a.yearEndPrice) * 100 : null)),
    }),
  );

  // ---------------------------------------------------------------------------------------------- shareholder
  const payout = L ? payoutYear(L) : null;
  rows.push(
    row('Shareholder', 'payout', 'Payout ratio', '%', 'above 100% is not sustainable', {
      ...graded(payout, (v) => (v > 100 ? 'warn' : 'info')),
      text: L && L.netIncome !== null && L.netIncome <= 0 ? 'net income not positive' : null,
      trend: yearly(payoutYear),
    }),
  );
  const buybackYield = (a: AnnualFact, px: number | null): number | null =>
    a.buybacks !== null && a.fx !== null && a.sharesDiluted !== null && px !== null && px > 0
      ? ((a.buybacks * a.fx) / (px * a.sharesDiluted)) * 100
      : null;
  rows.push(
    row('Shareholder', 'buyback_yield', 'Buyback yield', '%', 'context only', {
      ...graded(L ? buybackYield(L, hasPrice ? price : null) : null),
      text: noFx ? NO_FX : null,
      trend: yearly((a) => buybackYield(a, a.yearEndPrice)),
    }),
  );
  return rows;
}

function interestCoverRow(facts: Facts, fin: boolean): KpiRowView {
  const rule = 'screen filter 3: >= 2x';
  const make = (x: RowExtra) => row('Safety', 'interest_cover', 'Interest cover (EBIT / interest)', 'x', rule, x);
  if (fin) return make({ text: NOT_FOR_FINANCIALS });
  const L = facts.latest;
  if (!L || L.interestExpense === null || ebitOf(L) === null) return make({});
  if (L.interestExpense === 0) return make({ status: 'ok', text: 'no interest expense' });
  return make({
    ...graded(interestCoverYear(L), atLeast(2.2, 2)),
    trend: trendOf(yearlyValues(facts, 5, interestCoverYear)),
  });
}

function netDebtRow(facts: Facts, fin: boolean): KpiRowView {
  const rule = `<= ${NET_DEBT_EBITDA_MAX} (scan gate)`;
  const make = (x: RowExtra) => row('Safety', 'net_debt_ebitda', 'Net debt / EBITDA', 'x', rule, x);
  if (fin) return make({ text: NOT_FOR_FINANCIALS });
  const trend = trendOf(yearlyValues(facts, 5, netDebtEbitdaYear));
  const okOrFail = (x: number): Status => (x <= NET_DEBT_EBITDA_MAX ? 'ok' : 'fail');
  const netCash = make({ value: 0, status: 'ok', text: 'net cash', trend });
  const given = facts.extras.netDebtEbitda;
  if (given !== null) return given < 0 ? netCash : make({ ...graded(given, okOrFail), trend });
  const L = facts.latest;
  if (!L || L.totalDebt === null || L.cash === null || L.ebitda === null) return make({});
  const netDebt = L.totalDebt - L.cash;
  if (L.ebitda <= 0) return netDebt <= 0 ? netCash : make({ status: 'fail', text: 'EBITDA not positive', trend });
  const x = netDebt / L.ebitda;
  return x < 0 ? netCash : make({ ...graded(x, okOrFail), trend });
}

function debtNiRow(facts: Facts, fin: boolean): KpiRowView {
  const rule = '< 3 years (checklist)';
  const make = (x: RowExtra) => row('Safety', 'debt_ni', 'Interest-bearing debt / net income', 'yrs', rule, x);
  if (fin) return make({ text: NOT_FOR_FINANCIALS });
  const L = facts.latest;
  if (!L || L.totalDebt === null || L.netIncome === null) return make({});
  const trend = trendOf(yearlyValues(facts, 5, debtNiYear));
  if (L.netIncome <= 0) {
    return L.totalDebt === 0
      ? make({ value: 0, status: 'ok', trend })
      : make({ status: 'warn', text: 'net income not positive', trend });
  }
  return make({ ...graded(L.totalDebt / L.netIncome, (v) => (v < 3 ? 'ok' : 'warn')), trend });
}

function peRow(facts: Facts): KpiRowView {
  const rule = 'cheap <= 33rd, expensive > 66th percentile of its own history';
  const L = facts.latest;
  const pts = peHistory(facts);
  const window = pts.length < 3 ? `${pts.length} yearly P/E points` : null;
  const trend = trendOf(pts);
  const make = (x: RowExtra) => row('Valuation', 'pe', 'P/E (trailing)', 'x', rule, { window, trend, ...x });
  if (!L) return make({});
  if (L.fx === null) return make({ text: NO_FX });
  if (L.eps === null || !(facts.price > 0)) return make({});
  if (L.eps <= 0) return make({ text: 'loss-making: P/E not meaningful' });
  const pe = r6(facts.price / L.eps);
  if (pts.length < 3) return make({ value: pe });
  const pct = Math.round(percentRank(pts, pe));
  return make({
    value: pe,
    status: pct <= 33 ? 'ok' : pct > 66 ? 'warn' : 'info',
    text: `${ordinal(pct)} percentile of own history`,
  });
}

// ------------------------------------------------------------------------------------------------------- quarters
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The last four quarterly statements, oldest first (half-years, labelled "6M Jun 25", when the name reports twice a
 * year and has no quarterly statements). Revenue growth is against the statement a year earlier when it is stored.
 * EPS surprise is always null: the app holds no analyst estimates.
 */
export function quarterRows(facts: Facts): QuarterRowView[] {
  const subs = facts.subPeriods;
  return lastN(subs, 4).map((s) => {
    const month = Number(s.periodEnd.slice(5, 7));
    const yy = s.periodEnd.slice(2, 4);
    const label =
      s.kind === 'quarterly'
        ? `Q${Math.ceil(month / 3)} ${yy}`
        : `6M ${MONTHS[month - 1] ?? s.periodEnd.slice(5, 7)} ${yy}`;
    const prior = subs.find((p) => p.currency === s.currency && sameQuarterLastYear(p.periodEnd, s.periodEnd));
    const yoy =
      prior && isNum(s.revenue) && isNum(prior.revenue) && prior.revenue > 0
        ? (s.revenue / prior.revenue - 1) * 100
        : null;
    const gm = isNum(s.grossProfit) && isNum(s.revenue) && s.revenue > 0 ? (s.grossProfit / s.revenue) * 100 : null;
    return {
      label,
      revenueYoyPct: yoy === null ? null : r6(yoy),
      grossMarginPct: gm === null ? null : r6(gm),
      epsSurprisePct: null,
    };
  });
}

/** `earlier` is 335 to 395 days before `later`: the same quarter a year before, allowing for 52/53-week calendars. */
function sameQuarterLastYear(earlier: string, later: string): boolean {
  const days = diffDays(later, earlier);
  return days >= 335 && days <= 395;
}
