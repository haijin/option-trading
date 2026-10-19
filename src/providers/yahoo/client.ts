import YahooFinance from 'yahoo-finance2';
import type { ISODate } from '../../core/dates';

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly symbol: string,
    message: string,
    readonly code: string = 'error',
  ) {
    super(`${provider} ${symbol}: ${message}`);
    this.name = 'ProviderError';
  }
}

export interface RawChart {
  timezone: string;
  currency: string | null;
  quotes: {
    date: unknown;
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    adjclose?: unknown;
    volume: unknown;
  }[];
}

export interface RawOptionRow {
  strike: unknown;
  bid?: unknown;
  ask?: unknown;
  lastPrice?: unknown;
  volume?: unknown;
  openInterest?: unknown;
  impliedVolatility?: unknown;
  expiration?: unknown;
  contractSize?: unknown;
}

export interface RawOptions {
  expirationDates: unknown[];
  underlyingPrice: unknown;
  underlyingTime: unknown;
  puts: RawOptionRow[];
  calls: RawOptionRow[];
  expiry: unknown;
}

export interface RawCalendar {
  earningsDates: unknown[];
  earningsIsEstimate: boolean;
  exDividendDate: unknown;
}

export interface RawProfile {
  name: string | null;
  sector: string | null;
  industry: string | null;
  tradingCurrency: string | null;
  financialCurrency: string | null;
}

export type RawFundamentalRow = Record<string, unknown>;

const SILENT = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };

/** Thin wrapper over yahoo-finance2 with an injectable fetch (recorded fixtures in tests). Schema validation is off:
 * Yahoo's payloads drift, so the normalisers validate the fields they need and skip rows they cannot trust. */
export class YahooClient {
  private readonly yf: InstanceType<typeof YahooFinance>;

  constructor(opts: { fetch?: typeof fetch } = {}) {
    this.yf = new YahooFinance({
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      suppressNotices: ['yahooSurvey'],
      versionCheck: false,
      logger: SILENT,
      validation: { logErrors: false, logOptionsErrors: false },
      queue: { concurrency: 3 },
    } as never);
  }

  private wrap<T>(symbol: string, what: string, p: Promise<T>): Promise<T> {
    return p.catch((err: Error) => {
      const code = /Not Found|No data found/i.test(err.message)
        ? 'not_found'
        : /429|Too Many/i.test(err.message)
          ? 'rate_limit'
          : 'error';
      throw new ProviderError('yahoo', symbol, `${what}: ${err.message.split('\n')[0]}`, code);
    });
  }

  async chart(symbol: string, from: ISODate, to: ISODate): Promise<RawChart> {
    const r = (await this.wrap(
      symbol,
      'chart',
      this.yf.chart(
        symbol,
        { period1: from, period2: to, interval: '1d' } as never,
        {
          validateResult: false,
        } as never,
      ) as Promise<unknown>,
    )) as { meta?: { exchangeTimezoneName?: string; currency?: string | null }; quotes?: RawChart['quotes'] };
    return {
      timezone: r.meta?.exchangeTimezoneName ?? 'UTC',
      currency: r.meta?.currency ?? null,
      quotes: r.quotes ?? [],
    };
  }

  async fundamentals(symbol: string, type: 'annual' | 'quarterly', from: ISODate): Promise<RawFundamentalRow[]> {
    const rows = (await this.wrap(
      symbol,
      `fundamentals ${type}`,
      this.yf.fundamentalsTimeSeries(
        symbol,
        { period1: from, type, module: 'all' } as never,
        {
          validateResult: false,
        } as never,
      ) as Promise<unknown>,
    )) as RawFundamentalRow[];
    return Array.isArray(rows) ? rows : [];
  }

  async options(symbol: string, expiry?: Date): Promise<RawOptions> {
    const r = (await this.wrap(
      symbol,
      'options',
      this.yf.options(
        symbol,
        (expiry ? { date: expiry } : {}) as never,
        { validateResult: false } as never,
      ) as Promise<unknown>,
    )) as {
      expirationDates?: unknown[];
      quote?: { regularMarketPrice?: unknown; regularMarketTime?: unknown };
      options?: { expirationDate?: unknown; puts?: RawOptionRow[]; calls?: RawOptionRow[] }[];
    };
    const first = r.options?.[0];
    return {
      expirationDates: r.expirationDates ?? [],
      underlyingPrice: r.quote?.regularMarketPrice,
      underlyingTime: r.quote?.regularMarketTime,
      puts: first?.puts ?? [],
      calls: first?.calls ?? [],
      expiry: first?.expirationDate,
    };
  }

  async calendar(symbol: string): Promise<RawCalendar> {
    const r = (await this.wrap(
      symbol,
      'calendarEvents',
      this.yf.quoteSummary(
        symbol,
        { modules: ['calendarEvents'] } as never,
        { validateResult: false } as never,
      ) as Promise<unknown>,
    )) as {
      calendarEvents?: {
        earnings?: { earningsDate?: unknown[]; isEarningsDateEstimate?: boolean };
        exDividendDate?: unknown;
      };
    };
    return {
      earningsDates: r.calendarEvents?.earnings?.earningsDate ?? [],
      earningsIsEstimate: r.calendarEvents?.earnings?.isEarningsDateEstimate ?? true,
      exDividendDate: r.calendarEvents?.exDividendDate,
    };
  }

  async profile(symbol: string): Promise<RawProfile> {
    const r = (await this.wrap(
      symbol,
      'profile',
      this.yf.quoteSummary(
        symbol,
        { modules: ['summaryProfile', 'price', 'financialData'] } as never,
        { validateResult: false } as never,
      ) as Promise<unknown>,
    )) as {
      summaryProfile?: { sector?: string; industry?: string };
      price?: { longName?: string; shortName?: string; currency?: string };
      financialData?: { financialCurrency?: string };
    };
    return {
      name: r.price?.longName ?? r.price?.shortName ?? null,
      sector: r.summaryProfile?.sector ?? null,
      industry: r.summaryProfile?.industry ?? null,
      tradingCurrency: r.price?.currency ?? null,
      financialCurrency: r.financialData?.financialCurrency ?? null,
    };
  }
}
