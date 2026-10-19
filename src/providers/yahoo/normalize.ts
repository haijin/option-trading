/** Pure normalisers from Yahoo's raw payloads to the app's types. Rows that cannot be trusted are dropped, never guessed. */
import type { Market } from '../../core/calendar';
import { addDays, diffDays, type ISODate } from '../../core/dates';
import type { DailyBar, OptionChainSnapshot, OptionQuote, PeriodType } from '../../core/types';
import type { StatementInput } from '../../db/writers';
import type { RawCalendar, RawChart, RawFundamentalRow, RawOptionRow, RawOptions } from './client';

export const MARKET_TZ: Record<Market, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong' };

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();

/** Calendar date of an instant in the given IANA timezone (en-CA formats as YYYY-MM-DD). */
export function localDate(d: Date, tz: string): ISODate {
  let f = dateFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFmtCache.set(tz, f);
  }
  return f.format(d);
}

export function toDate(x: unknown): Date | null {
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x;
  if (typeof x === 'number' && Number.isFinite(x)) return new Date(x > 1e11 ? x : x * 1000);
  if (typeof x === 'string' && x) {
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function finite(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ bars
export function normalizeChartBars(raw: RawChart, source: string): DailyBar[] {
  const byDay = new Map<ISODate, DailyBar>();
  for (const q of raw.quotes) {
    const date = toDate(q.date);
    const open = finite(q.open);
    const high = finite(q.high);
    const low = finite(q.low);
    const close = finite(q.close);
    if (!date || open === null || high === null || low === null || close === null || close <= 0) continue;
    const day = localDate(date, raw.timezone);
    byDay.set(day, {
      day,
      open,
      high,
      low,
      close,
      adjClose: finite(q.adjclose) ?? close,
      volume: Math.max(0, Math.round(finite(q.volume) ?? 0)),
      source,
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------- fundamentals
const PERIOD_TYPE: Record<string, PeriodType> = { '12M': 'annual', '6M': 'semiannual', '3M': 'quarterly' };

const pick = (row: RawFundamentalRow, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = finite(row[k]);
    if (v !== null) return v;
  }
  return null;
};

export function normalizeStatementRow(
  row: RawFundamentalRow,
  ctx: { currency: string; source?: string },
): StatementInput | null {
  const periodEnd = toDate(row.date);
  const periodType = PERIOD_TYPE[String(row.periodType ?? '')];
  if (!periodEnd || !periodType) return null;
  const s: StatementInput = {
    periodEnd: periodEnd.toISOString().slice(0, 10),
    periodType,
    currency: ctx.currency as StatementInput['currency'],
    revenue: pick(row, 'totalRevenue', 'operatingRevenue'),
    grossProfit: pick(row, 'grossProfit'),
    operatingIncome: pick(row, 'operatingIncome', 'totalOperatingIncomeAsReported'),
    ebit: pick(row, 'EBIT'),
    ebitda: pick(row, 'EBITDA'),
    interestExpense: pick(row, 'interestExpense', 'interestExpenseNonOperating'),
    netIncome: pick(row, 'netIncome', 'netIncomeCommonStockholders'),
    epsDiluted: pick(row, 'dilutedEPS'),
    sharesDiluted: pick(row, 'dilutedAverageShares', 'ordinarySharesNumber'),
    totalAssets: pick(row, 'totalAssets'),
    currentAssets: pick(row, 'currentAssets'),
    currentLiabilities: pick(row, 'currentLiabilities'),
    totalLiabilities: pick(row, 'totalLiabilitiesNetMinorityInterest'),
    longTermDebt: pick(row, 'longTermDebt'),
    totalDebt: pick(row, 'totalDebt'),
    cash: pick(row, 'cashCashEquivalentsAndShortTermInvestments', 'cashAndCashEquivalents'),
    retainedEarnings: pick(row, 'retainedEarnings'),
    totalEquity: pick(row, 'stockholdersEquity', 'commonStockEquity'),
    cfo: pick(row, 'operatingCashFlow', 'cashFlowFromContinuingOperatingActivities'),
    capex: pick(row, 'capitalExpenditure'),
    fcf: pick(row, 'freeCashFlow'),
    dividendsPaid: pick(row, 'cashDividendsPaid', 'commonStockDividendPaid'),
    buybacks: pick(row, 'repurchaseOfCapitalStock', 'commonStockPayments'),
    source: ctx.source ?? 'yahoo',
    reportedAtActual: null,
    raw: null,
  };
  // A row with no balance-sheet or income data at all carries no information.
  if (s.totalAssets === null && s.revenue === null && s.netIncome === null) return null;
  return s;
}

// ----------------------------------------------------------------- chains
export interface ChainNormalizeOptions {
  asOfMarketDate: ISODate;
  multiplier: number;
  /** Keep puts with strike within [lo, hi] x spot. */
  strikeLo: number;
  strikeHi: number;
}

export interface RawChainBatch {
  underlyingPrice: number;
  /** Local (exchange) date of the underlying quote: the snapshot date. */
  snapshotDate: ISODate;
  puts: { expiry: ISODate; row: RawOptionRow }[];
}

export function normalizePutRows(
  rows: { expiry: ISODate; row: RawOptionRow }[],
  opts: { underlying: number; multiplier: number; strikeLo: number; strikeHi: number },
): OptionQuote[] {
  const out: OptionQuote[] = [];
  for (const { expiry, row } of rows) {
    const strike = finite(row.strike);
    if (strike === null || strike <= 0) continue;
    if (strike < opts.strikeLo * opts.underlying || strike > opts.strikeHi * opts.underlying) continue;
    const bid = finite(row.bid);
    const ask = finite(row.ask);
    const iv = finite(row.impliedVolatility);
    out.push({
      expiry,
      strike,
      right: 'P',
      bid: bid !== null && bid >= 0 ? bid : null,
      ask: ask !== null && ask >= 0 ? ask : null,
      last: finite(row.lastPrice),
      volume: finite(row.volume),
      openInterest: finite(row.openInterest),
      // Yahoo reports near-zero IVs for illiquid or stale rows: those are no information, not a real 0% vol.
      iv: iv !== null && iv >= 0.01 && iv <= 5 ? iv : null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      multiplier: opts.multiplier,
    });
  }
  return out;
}

export function expiryOf(row: RawOptions): ISODate | null {
  const d = toDate(row.expiry);
  return d ? d.toISOString().slice(0, 10) : null;
}

export function buildYahooSnapshot(
  batch: RawChainBatch,
  multiplier: number,
  range = { lo: 0.5, hi: 1.15 },
): OptionChainSnapshot {
  return {
    snapshotDate: batch.snapshotDate,
    underlyingPrice: batch.underlyingPrice,
    source: 'yahoo',
    tier: 'real',
    quotes: normalizePutRows(batch.puts, {
      underlying: batch.underlyingPrice,
      multiplier,
      strikeLo: range.lo,
      strikeHi: range.hi,
    }),
  };
}

/** Expiry dates (UTC midnight instants from Yahoo) within [minDte, maxDte] of the snapshot date. */
export function selectExpiries(
  expirationDates: unknown[],
  snapshotDate: ISODate,
  minDte: number,
  maxDte: number,
): Date[] {
  const out: Date[] = [];
  for (const x of expirationDates) {
    const d = toDate(x);
    if (!d) continue;
    const dte = diffDays(d.toISOString().slice(0, 10), snapshotDate);
    if (dte >= minDte && dte <= maxDte) out.push(d);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// ----------------------------------------------------------------- events
export interface NormalizedCalendar {
  earnings: { date: ISODate; confirmed: boolean }[];
  exDividend: ISODate | null;
}

export function normalizeCalendar(raw: RawCalendar, market: Market): NormalizedCalendar {
  const tz = MARKET_TZ[market];
  const dates = raw.earningsDates
    .map(toDate)
    .filter((d): d is Date => d !== null)
    .map((d) => localDate(d, tz));
  const first = dates.sort()[0];
  const ex = toDate(raw.exDividendDate);
  return {
    // A two-date range is Yahoo's estimate window: keep the earliest and mark it unconfirmed.
    earnings: first ? [{ date: first, confirmed: !raw.earningsIsEstimate && dates.length === 1 }] : [],
    exDividend: ex ? ex.toISOString().slice(0, 10) : null,
  };
}

export { addDays };
