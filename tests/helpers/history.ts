/** Deterministic synthetic data for skill tests: bars, indices, statements and an in-memory InstrumentHistory. */
import { isTradingDay, type Market } from '../../src/core/calendar';
import { addDays, type ISODate } from '../../src/core/dates';
import type { StrategyParams } from '../../src/core/params';
import { defaultParams } from '../../src/core/params';
import type {
  CalibrationRow,
  CorporateEvent,
  Currency,
  DailyBar,
  FundamentalStatement,
  Instrument,
  JournalOutcome,
  OptionChainSnapshot,
  PortfolioState,
} from '../../src/core/types';
import { bsPrice } from '../../src/indicators/black-scholes';
import type { SkillContext } from '../../src/skills/contract';
import { createDataAccess, type DataAccessOptions, type InstrumentHistory } from '../../src/skills/data-access';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The last `n` trading days of `market` ending on or before `end`, ascending. */
export function tradingDaysEnding(market: Market, end: ISODate, n: number): ISODate[] {
  const out: ISODate[] = [];
  let d = end;
  while (out.length < n) {
    if (isTradingDay(market, d)) out.push(d);
    d = addDays(d, -1);
  }
  return out.reverse();
}

export function barsFromCloses(
  closes: number[],
  end: ISODate,
  market: Market = 'US',
  opts: { range?: number; volume?: number | ((i: number) => number); source?: string } = {},
): DailyBar[] {
  const days = tradingDaysEnding(market, end, closes.length);
  const range = opts.range ?? 0.01;
  return closes.map((c, i) => {
    const prev = i > 0 ? (closes[i - 1] as number) : c;
    const open = prev;
    return {
      day: days[i] as string,
      open,
      high: Math.max(open, c) * (1 + range / 2),
      low: Math.min(open, c) * (1 - range / 2),
      close: c,
      adjClose: c,
      volume: typeof opts.volume === 'function' ? opts.volume(i) : (opts.volume ?? 1_000_000),
      source: opts.source ?? 'yahoo',
    };
  });
}

export interface WalkOptions {
  n: number;
  start: number;
  drift: number;
  vol: number;
  seed: number;
}

export function walkCloses(o: WalkOptions): number[] {
  const r = rng(o.seed);
  const out: number[] = [];
  let p = o.start;
  for (let i = 0; i < o.n; i++) {
    // Box-Muller
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    p *= Math.exp(o.drift - 0.5 * o.vol * o.vol + o.vol * z);
    out.push(p);
  }
  return out;
}

/** Linear path from `from` to `to` over n points. */
export function linear(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

export function instrument(over: Partial<Instrument> = {}): Instrument {
  return {
    id: 1,
    market: 'US',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    currency: 'USD',
    sector: 'Technology',
    industry: 'Consumer Electronics',
    solvencyModel: 'altman',
    reportingFrequency: 'quarterly',
    benchmarkInstrumentId: null,
    multiplier: 100,
    hasListedOptions: true,
    providerSymbols: {},
    ...over,
  };
}

export function statement(periodEnd: string, over: Partial<FundamentalStatement> = {}): FundamentalStatement {
  return {
    periodEnd,
    periodType: 'annual',
    reportedAt: `${addDays(periodEnd, 60)}T00:00:00.000Z`,
    reportedAtEstimated: true,
    firstSeenAt: '2026-10-10T00:00:00.000Z',
    currency: 'USD',
    revenue: 1000,
    grossProfit: 400,
    operatingIncome: 200,
    ebit: 210,
    ebitda: 250,
    interestExpense: 10,
    netIncome: 150,
    epsDiluted: 1.5,
    sharesDiluted: 100,
    totalAssets: 2000,
    currentAssets: 800,
    currentLiabilities: 500,
    totalLiabilities: 900,
    longTermDebt: 300,
    totalDebt: 350,
    cash: 200,
    retainedEarnings: 600,
    totalEquity: 1100,
    cfo: 220,
    capex: -50,
    fcf: 170,
    dividendsPaid: -40,
    buybacks: -20,
    source: 'yahoo',
    ...over,
  };
}

export interface HistoryOptions {
  instrument?: Partial<Instrument>;
  end?: ISODate;
  closes?: number[];
  bars?: DailyBar[];
  indexCloses?: number[];
  volIndexCloses?: number[] | null;
  statements?: FundamentalStatement[];
  events?: CorporateEvent[];
  chain?: OptionChainSnapshot | null;
  ivPoints?: InstrumentHistory['ivPoints'];
  fx?: InstrumentHistory['fx'];
  calibration?: CalibrationRow[];
  journal?: JournalOutcome[];
  ledger?: InstrumentHistory['ledger'];
}

export const END = '2026-10-09';

export function makeHistory(o: HistoryOptions = {}): InstrumentHistory {
  const inst = instrument(o.instrument);
  const end = o.end ?? END;
  const closes = o.closes ?? walkCloses({ n: 600, start: 100, drift: 0.0004, vol: 0.012, seed: 7 });
  const indexCloses = o.indexCloses ?? walkCloses({ n: 600, start: 400, drift: 0.0003, vol: 0.008, seed: 11 });
  const volCloses = o.volIndexCloses === undefined ? linear(18, 18, 600) : o.volIndexCloses;
  return {
    instrument: inst,
    bars: o.bars ?? barsFromCloses(closes, end, inst.market),
    indexSymbol: inst.market === 'US' ? 'SPY' : '2800',
    indexBars: barsFromCloses(indexCloses, end, inst.market, { volume: 5_000_000 }),
    volIndexSymbol: inst.market === 'US' ? 'VIX' : 'VHSI',
    volIndexBars: volCloses ? barsFromCloses(volCloses, end, inst.market, { volume: 0 }) : [],
    statements: o.statements ?? [],
    events: o.events ?? [],
    ivPoints: o.ivPoints ?? [],
    chainAsOf: async (asOf) => {
      const c = o.chain ?? null;
      return c && c.snapshotDate <= asOf ? c : null;
    },
    fx: o.fx ?? {
      USDHKD: [{ day: end, rate: 7.8 }],
      CNYHKD: [{ day: end, rate: 1.17 }],
    },
    calibration: o.calibration ?? [],
    journal: o.journal ?? [],
    ...(o.ledger ? { ledger: o.ledger } : {}),
  };
}

export function portfolio(over: Partial<PortfolioState> = {}): PortfolioState {
  return {
    baseCurrency: 'HKD',
    equity: 2_000_000,
    openPositions: [],
    fxToBase: (from: Currency) => (from === 'HKD' ? 1 : from === 'USD' ? 7.8 : null),
    ...over,
  };
}

export function ctxFor(
  h: InstrumentHistory,
  asOf: ISODate = END,
  opts: {
    params?: StrategyParams;
    portfolio?: PortfolioState;
    priors?: DataAccessOptions['priors'];
    memo?: DataAccessOptions['memo'];
    conviction?: number | null;
    chainMaxAgeDays?: number;
  } = {},
): SkillContext {
  const params = opts.params ?? defaultParams();
  return {
    instrument: h.instrument,
    asOf,
    params,
    data: createDataAccess(h, asOf, {
      chainMaxAgeDays: opts.chainMaxAgeDays ?? params.runner.chainMaxAgeDays,
      priors: opts.priors ?? new Map(),
      memo: opts.memo ?? new Map(),
    }),
    portfolio: opts.portfolio ?? portfolio(),
    conviction: opts.conviction ?? null,
    maxCollateralPct: null,
    log: () => {},
  };
}

export interface BsChainOptions {
  spot: number;
  snapshotDate?: ISODate;
  sigma: number | ((strike: number, dte: number) => number);
  /** Days to expiry for each listed expiry, or explicit expiry dates. */
  dtes?: number[];
  expiries?: ISODate[];
  strikes?: number[];
  multiplier?: number;
  source?: OptionChainSnapshot['source'];
  oi?: number | null;
  /** Bid/ask spread as a fraction of the mid. */
  spreadPct?: number;
  withIv?: boolean;
  rate?: number;
  tier?: OptionChainSnapshot['tier'];
}

/** A put chain priced by Black-Scholes from a vol surface, so analytics must recover the surface. */
export function bsChain(o: BsChainOptions): OptionChainSnapshot {
  const snap = o.snapshotDate ?? END;
  const expiries = o.expiries ?? (o.dtes ?? [35]).map((d) => addDays(snap, d));
  const strikes = o.strikes ?? Array.from({ length: 21 }, (_, i) => Math.round(o.spot * (0.6 + i * 0.025) * 100) / 100);
  const quotes = [];
  for (const expiry of expiries) {
    const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${snap}T00:00:00Z`)) / 86_400_000);
    for (const k of strikes) {
      const sigma = typeof o.sigma === 'number' ? o.sigma : o.sigma(k, dte);
      const px = bsPrice('P', o.spot, k, dte / 365, o.rate ?? 0.04, sigma);
      const half = ((o.spreadPct ?? 0.04) * px) / 2;
      quotes.push({
        expiry,
        strike: k,
        right: 'P' as const,
        bid: Math.max(0, Math.round((px - half) * 1000) / 1000),
        ask: Math.round((px + half) * 1000) / 1000,
        last: Math.round(px * 1000) / 1000,
        volume: 50,
        openInterest: o.oi === undefined ? 500 : o.oi,
        iv: o.withIv === false ? null : sigma,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        multiplier: o.multiplier ?? 100,
      });
    }
  }
  return { snapshotDate: snap, underlyingPrice: o.spot, source: o.source ?? 'yahoo', tier: o.tier ?? 'real', quotes };
}
