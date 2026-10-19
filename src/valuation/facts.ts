/**
 * buildFacts: turns stored statements, bars and an FX lookup into the normalised annual series every other part of the
 * module reads. No judgement lives here, only unit handling:
 *
 *  - Annual statements are the periodType 'annual' rows; 'ttm' rows are ignored.
 *  - A name with NO annual statements but semiannual ones (HK reporters) gets annual figures by adding two half-years.
 *    Pairing starts from the latest half-year and walks back in non-overlapping pairs whose period ends are about six
 *    months apart (150 to 215 days) and share a currency; a half-year that cannot be paired is skipped (the year is
 *    dropped, never estimated). Flows (revenue, profit, cash flow, dividends) are added; balance-sheet items come from
 *    the later half; EPS is the sum of the two halves' EPS. The latest pair therefore ends at the latest half-year,
 *    which may be an interim date rather than the fiscal year end: that is deliberate (the newest 12 months).
 *  - Money stays in the statement currency, so ratios need no FX. `fx` (the latest rate, for every year) converts to the
 *    trading currency and is applied to the per-share fields. An unknown rate leaves those fields null and records a
 *    warning; nothing is invented.
 *  - Cash outflows (capex, dividends, buybacks) become positive magnitudes whatever sign the provider used.
 */
import { diffDays, type ISODate, yearOf } from '../core/dates';
import type { DailyBar, FundamentalStatement } from '../core/types';
import { isNum } from './math';
import type { AnnualFact, Facts, SubPeriodFact, ValuationInput } from './types';

const HALF_GAP_MIN_DAYS = 150;
const HALF_GAP_MAX_DAYS = 215;
/** A year-end price older than this (no bar close enough to the period end) is not used. */
const PRICE_MAX_GAP_DAYS = 10;
/** A fair value older than this gets a staleness warning. */
const FAIR_VALUE_STALE_DAYS = 180;
const SUB_PERIODS_KEPT = 8;

const FLOWS = [
  'revenue',
  'grossProfit',
  'operatingIncome',
  'ebit',
  'ebitda',
  'interestExpense',
  'netIncome',
  'cfo',
  'capex',
  'fcf',
  'dividendsPaid',
  'buybacks',
] as const;

const byPeriodEnd = (a: FundamentalStatement, b: FundamentalStatement): number =>
  a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0;

/** One statement per period end (the one reported last), ascending. */
function dedupe(rows: FundamentalStatement[]): FundamentalStatement[] {
  const m = new Map<string, FundamentalStatement>();
  for (const s of rows) {
    const prev = m.get(s.periodEnd);
    if (!prev || s.reportedAt > prev.reportedAt) m.set(s.periodEnd, s);
  }
  return [...m.values()].sort(byPeriodEnd);
}

function mergeHalves(h1: FundamentalStatement, h2: FundamentalStatement): FundamentalStatement {
  const out: FundamentalStatement = { ...h2 };
  for (const k of FLOWS) out[k] = isNum(h1[k]) && isNum(h2[k]) ? h1[k] + h2[k] : null;
  out.epsDiluted = isNum(h1.epsDiluted) && isNum(h2.epsDiluted) ? h1.epsDiluted + h2.epsDiluted : null;
  out.sharesDiluted =
    isNum(h1.sharesDiluted) && isNum(h2.sharesDiluted)
      ? (h1.sharesDiluted + h2.sharesDiluted) / 2
      : (h2.sharesDiluted ?? h1.sharesDiluted);
  return out;
}

function pairHalves(semis: FundamentalStatement[]): { merged: FundamentalStatement[]; skipped: number } {
  const merged: FundamentalStatement[] = [];
  let skipped = 0;
  let i = semis.length - 1;
  while (i >= 0) {
    const h2 = semis[i] as FundamentalStatement;
    const h1 = semis[i - 1];
    const gap = h1 ? diffDays(h2.periodEnd, h1.periodEnd) : 0;
    if (h1 && h1.currency === h2.currency && gap >= HALF_GAP_MIN_DAYS && gap <= HALF_GAP_MAX_DAYS) {
      merged.push(mergeHalves(h1, h2));
      i -= 2;
    } else {
      skipped++;
      i -= 1;
    }
  }
  return { merged: merged.reverse(), skipped };
}

/** Last close on or before `day`, when a bar exists within PRICE_MAX_GAP_DAYS of it. */
function priceOnOrBefore(bars: readonly DailyBar[], day: ISODate): number | null {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as DailyBar).day <= day) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const bar = bars[lo - 1] as DailyBar;
  return diffDays(day, bar.day) <= PRICE_MAX_GAP_DAYS && isNum(bar.close) && bar.close > 0 ? bar.close : null;
}

function toFact(
  s: FundamentalStatement,
  fromHalves: boolean,
  fx: number | null,
  bars: readonly DailyBar[],
): AnnualFact {
  const val = (x: number | null): number | null => (isNum(x) ? x : null);
  const mag = (x: number | null): number | null => (isNum(x) ? Math.abs(x) : null);
  const shares = isNum(s.sharesDiluted) && s.sharesDiluted > 0 ? s.sharesDiluted : null;
  const netIncome = val(s.netIncome);
  const cfo = val(s.cfo);
  const capex = mag(s.capex);
  const fcf = val(s.fcf) ?? (cfo !== null && capex !== null ? cfo - capex : null);
  const dividendsPaid = mag(s.dividendsPaid);
  const totalEquity = val(s.totalEquity);
  const epsStmt = val(s.epsDiluted) ?? (shares !== null && netIncome !== null ? netIncome / shares : null);
  const perShare = (x: number | null): number | null => (shares !== null && x !== null ? x / shares : null);
  const dpsStmt = perShare(dividendsPaid);
  const fcfPsStmt = perShare(fcf);
  const bvpsStmt = perShare(totalEquity);
  const trading = (x: number | null): number | null => (x !== null && fx !== null ? x * fx : null);
  const eps = trading(epsStmt);
  const yearEndPrice = priceOnOrBefore(bars, s.periodEnd);
  return {
    periodEnd: s.periodEnd,
    year: yearOf(s.periodEnd),
    currency: s.currency,
    fx,
    fromHalves,
    revenue: val(s.revenue),
    grossProfit: val(s.grossProfit),
    operatingIncome: val(s.operatingIncome),
    ebit: val(s.ebit),
    ebitda: val(s.ebitda),
    interestExpense: mag(s.interestExpense),
    netIncome,
    sharesDiluted: shares,
    totalDebt: val(s.totalDebt),
    cash: val(s.cash),
    totalEquity,
    cfo,
    capex,
    fcf,
    dividendsPaid,
    buybacks: mag(s.buybacks),
    epsStmt,
    dpsStmt,
    fcfPsStmt,
    bvpsStmt,
    eps,
    dps: trading(dpsStmt),
    fcfPs: trading(fcfPsStmt),
    bvps: trading(bvpsStmt),
    yearEndPrice,
    yearEndPe: yearEndPrice !== null && eps !== null && eps > 0 ? yearEndPrice / eps : null,
  };
}

export function buildFacts(input: ValuationInput): Facts {
  const warnings: string[] = [];

  const fxCache = new Map<string, number | null>();
  const fxOf = (ccy: string): number | null => {
    if (!fxCache.has(ccy)) {
      const raw = ccy === input.currency ? 1 : input.fxToTrading(ccy);
      const rate = isNum(raw) && raw > 0 ? raw : null;
      if (rate === null) {
        warnings.push(
          `No FX rate ${ccy} to ${input.currency}: per-share values, P/E, yields and the valuation methods that need them are unavailable`,
        );
      }
      fxCache.set(ccy, rate);
    }
    return fxCache.get(ccy) ?? null;
  };

  const price = isNum(input.price) && input.price > 0 ? input.price : 0;
  if (price === 0) warnings.push('No valid price: valuation ratios and the price comparison are unavailable');

  const annualStmts = dedupe(input.statements.filter((s) => s.periodType === 'annual'));
  const semiStmts = dedupe(input.statements.filter((s) => s.periodType === 'semiannual'));
  const quarterStmts = dedupe(input.statements.filter((s) => s.periodType === 'quarterly'));

  let periods: { stmt: FundamentalStatement; halves: boolean }[] = [];
  let annualFromHalves = false;
  if (annualStmts.length > 0) {
    periods = annualStmts.map((stmt) => ({ stmt, halves: false }));
  } else if (semiStmts.length > 0) {
    const { merged, skipped } = pairHalves(semiStmts);
    periods = merged.map((stmt) => ({ stmt, halves: true }));
    annualFromHalves = merged.length > 0;
    if (merged.length > 0) {
      warnings.push(
        `No annual statements: annual figures are the sum of ${merged.length} pairs of half-year statements`,
      );
    }
    if (skipped > 0) {
      warnings.push(`${skipped} half-year statement(s) had no partner within six months and were skipped`);
    }
  } else if (quarterStmts.length > 0) {
    warnings.push('Only quarterly statements are stored: annual figures need annual or semiannual statements');
  }

  const annual = periods.map((p) => toFact(p.stmt, p.halves, fxOf(p.stmt.currency), input.bars));
  const currencies = new Set(annual.map((a) => a.currency));
  const mixedCurrency = currencies.size > 1;
  if (mixedCurrency) {
    warnings.push(
      `Statements are reported in several currencies (${[...currencies].join(', ')}): growth is measured after conversion at the latest rate`,
    );
  }

  const subSource = quarterStmts.length > 0 ? quarterStmts : semiStmts;
  const subKind = quarterStmts.length > 0 ? 'quarterly' : 'semiannual';
  const subPeriods: SubPeriodFact[] = subSource.slice(-SUB_PERIODS_KEPT).map((s) => ({
    periodEnd: s.periodEnd,
    kind: subKind,
    currency: s.currency,
    revenue: isNum(s.revenue) ? s.revenue : null,
    grossProfit: isNum(s.grossProfit) ? s.grossProfit : null,
  }));

  const first = input.bars[0];
  const last = input.bars[input.bars.length - 1];
  const barsSpanYears = first && last ? diffDays(last.day, first.day) / 365.25 : null;

  let fairValue: Facts['fairValue'] = null;
  if (input.fairValue) {
    const fv = input.fairValue;
    if (isNum(fv.value) && fv.value > 0) {
      fairValue = { ...fv };
      const age = /^\d{4}-\d{2}-\d{2}/.test(fv.asOf) ? diffDays(input.asOf, fv.asOf.slice(0, 10)) : null;
      if (age !== null && age > FAIR_VALUE_STALE_DAYS) {
        warnings.push(`The imported fair value is ${age} days old (as of ${fv.asOf.slice(0, 10)})`);
      }
    } else {
      warnings.push('The imported fair value is not a positive number and was ignored');
    }
  }

  const x: NonNullable<ValuationInput['extras']> = input.extras ?? {};
  return {
    symbol: input.symbol,
    market: input.market,
    currency: input.currency,
    solvencyModel: input.solvencyModel,
    asOf: input.asOf,
    price,
    annual,
    latest: annual[annual.length - 1] ?? null,
    annualFromHalves,
    mixedCurrency,
    subPeriods,
    barsSpanYears,
    extras: {
      altmanZ: isNum(x.altmanZ) ? x.altmanZ : null,
      fScore: isNum(x.fScore) ? x.fScore : null,
      netDebtEbitda: isNum(x.netDebtEbitda) ? x.netDebtEbitda : null,
    },
    fairValue,
    warnings,
  };
}
