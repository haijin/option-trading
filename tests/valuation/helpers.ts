/**
 * Fixtures for the valuation tests: realistic annual statements for a made-up company, price bars, and a ValuationInput
 * builder. Plain numbers only: no database, no clock, no network.
 */
import { addDays, type ISODate, yearOf } from '../../src/core/dates';
import type { DailyBar, FundamentalStatement } from '../../src/core/types';
import { buildFacts, type Facts, type ValuationInput } from '../../src/valuation';

export const AS_OF: ISODate = '2026-10-09';

/** A statement with flat, easy-to-check numbers: ROE 14%, gross margin 45%, net margin 14%, OCF/NI 1.1, cover 21x ... */
export function stmt(periodEnd: ISODate, over: Partial<FundamentalStatement> = {}): FundamentalStatement {
  return {
    periodEnd,
    periodType: 'annual',
    reportedAt: `${addDays(periodEnd, 60)}T00:00:00.000Z`,
    reportedAtEstimated: false,
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    currency: 'USD',
    revenue: 1000,
    grossProfit: 450,
    operatingIncome: 200,
    ebit: 210,
    ebitda: 250,
    interestExpense: 10,
    netIncome: 140,
    epsDiluted: 1.4,
    sharesDiluted: 100,
    totalAssets: 2000,
    currentAssets: 800,
    currentLiabilities: 500,
    totalLiabilities: 900,
    longTermDebt: 280,
    totalDebt: 300,
    cash: 150,
    retainedEarnings: 600,
    totalEquity: 1000,
    cfo: 154,
    capex: -60,
    fcf: 94,
    dividendsPaid: -56,
    buybacks: -7,
    source: 'test',
    ...over,
  };
}

type Over = Partial<FundamentalStatement> | ((i: number, year: number) => Partial<FundamentalStatement>);

/** `n` annual statements for the fiscal years ending Dec 31 of (lastYear - n + 1) ... lastYear, ascending. */
export function flat(n: number, over: Over = {}, lastYear = 2025): FundamentalStatement[] {
  return Array.from({ length: n }, (_, i) => {
    const year = lastYear - n + 1 + i;
    return stmt(`${year}-12-31`, typeof over === 'function' ? over(i, year) : over);
  });
}

/**
 * A growing, high-quality company ("Acme Foods"): revenue +6% a year, 45% gross margin, 14% net margin, equity +5%,
 * 1% buybacks, OCF = 1.1 x net income, capex 6% of revenue. FY2016 is year 0; `n` takes the last n years to FY2025.
 */
export function acme(n = 10, over: Over = {}): FundamentalStatement[] {
  return Array.from({ length: n }, (_, i) => {
    const year = 2025 - n + 1 + i;
    const k = year - 2016;
    const revenue = 1000 * 1.06 ** k;
    const netIncome = 0.14 * revenue;
    const shares = 100 * 0.99 ** k;
    const cfo = 1.1 * netIncome;
    const extra = typeof over === 'function' ? over(i, year) : over;
    return stmt(`${year}-12-31`, {
      revenue,
      grossProfit: 0.45 * revenue,
      operatingIncome: 0.2 * revenue,
      ebit: 0.21 * revenue,
      ebitda: 0.25 * revenue,
      interestExpense: 12,
      netIncome,
      epsDiluted: netIncome / shares,
      sharesDiluted: shares,
      totalEquity: 700 * 1.05 ** k,
      totalDebt: 300,
      cash: 150,
      cfo,
      capex: -0.06 * revenue,
      fcf: cfo - 0.06 * revenue,
      dividendsPaid: -0.4 * netIncome,
      buybacks: -0.05 * netIncome,
      ...extra,
    });
  });
}

/** Weekly bars between two dates (inclusive of `from`), closes from `price(day)`. */
export function weeklyBars(from: ISODate, to: ISODate, price: (day: ISODate) => number): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let day = from; day <= to; day = addDays(day, 7)) {
    const close = price(day);
    bars.push({ day, open: close, high: close, low: close, close, adjClose: close, volume: 1000, source: 'test' });
  }
  return bars;
}

/** A gently rising price with a wobble, 2015-12-28 to AS_OF: year-end P/Es vary around 16 for `acme()`. */
export function acmeBars(from: ISODate = '2015-12-28'): DailyBar[] {
  return weeklyBars(from, AS_OF, (day) => {
    const t = (Date.parse(`${day}T00:00:00Z`) - Date.parse('2016-01-01T00:00:00Z')) / (365.25 * 86_400_000);
    return 1.4 * 1.0707 ** t * 16 * (1 + 0.15 * Math.sin(t * 1.3));
  });
}

/** One close per calendar year (the same close on every weekly bar of that year): year-end P/E = close / EPS exactly. */
export function yearlyBars(closeByYear: Record<number, number>, from: ISODate, to: ISODate = AS_OF): DailyBar[] {
  const years = Object.keys(closeByYear).map(Number);
  const last = closeByYear[Math.max(...years)] as number;
  return weeklyBars(from, to, (day) => closeByYear[yearOf(day)] ?? last);
}

export const usdOnly = (ccy: string): number | null => (ccy === 'USD' ? 1 : null);

export function input(over: Partial<ValuationInput> = {}): ValuationInput {
  return {
    symbol: 'ACME',
    market: 'US',
    currency: 'USD',
    solvencyModel: 'altman',
    asOf: AS_OF,
    price: 40,
    bars: acmeBars(),
    statements: acme(10),
    fxToTrading: usdOnly,
    ...over,
  };
}

export function factsFor(over: Partial<ValuationInput> = {}): Facts {
  return buildFacts(input(over));
}

/** Facts from flat statements (`n` years) with an optional price; bars cover 2015-12-28 to AS_OF unless given. */
export function flatFacts(n: number, over: Over = {}, extra: Partial<ValuationInput> = {}): Facts {
  return buildFacts(input({ statements: flat(n, over), ...extra }));
}

/** Recursively assert no NaN or Infinity anywhere in a value (JSON would silently turn them into null). */
export function assertNoNaN(value: unknown, path = 'value'): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} is ${value}`);
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertNoNaN(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}
