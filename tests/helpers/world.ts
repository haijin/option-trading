/** A multi-instrument, multi-market world for runner and lookahead tests, plus in-memory runner ports. */
import type { Market } from '../../src/core/calendar';
import { addDays, type ISODate } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type {
  CalibrationRow,
  CorporateEvent,
  FundamentalStatement,
  JournalOutcome,
  OptionChainSnapshot,
  PortfolioState,
  SolvencyModel,
} from '../../src/core/types';
import type { SkillResult } from '../../src/skills/contract';
import { createDataAccess, type InstrumentHistory } from '../../src/skills/data-access';
import type { RunnerPorts, WatchInstrument } from '../../src/skills/runner';
import { targetExpiries } from '../../src/skills/s4-option-select';
import { barsFromCloses, bsChain, rng, statement, tradingDaysEnding, walkCloses } from './history';

export const WORLD_END = '2026-10-09';

export interface NameSpec {
  id: number;
  market: Market;
  symbol: string;
  sector?: string | null;
  solvencyModel?: SolvencyModel;
  multiplier?: number;
  seed?: number;
  drift?: number;
  vol?: number;
  start?: number;
  /** 'bs' = real Black-Scholes chain dated at asOf; 'csv' = pasted chain; 'none' = no chain. */
  chain?: 'bs' | 'csv' | 'none';
  chainAgeDays?: number;
  chainSigma?: number;
  annuals?: number;
  earnings?: ISODate | null;
  conviction?: number | null;
  /** Bars end this many trading days after asOf (the "future" that must not matter). */
  futureBars?: number;
  /** Keep the vol index (default true). */
  volIndex?: boolean;
  /** Stop bars this many trading days before asOf (stale data). */
  staleBy?: number;
}

export function improvingAnnuals(n: number, lastYear = 2025): FundamentalStatement[] {
  return Array.from({ length: n }, (_, i) =>
    statement(`${lastYear - (n - 1) + i}-12-31`, {
      revenue: 1500 * 1.08 ** i,
      grossProfit: 1500 * 1.08 ** i * (0.4 + 0.01 * i),
      ebit: 300 + 20 * i,
      ebitda: 350 + 20 * i,
      interestExpense: 10,
      netIncome: 100 + 15 * i,
      epsDiluted: 1 + 0.15 * i,
      sharesDiluted: 100 - i,
      totalAssets: 2000 * 1.04 ** i,
      currentAssets: 800 + 40 * i,
      currentLiabilities: 500,
      totalLiabilities: 900,
      longTermDebt: 320 - 15 * i,
      totalDebt: 360 - 15 * i,
      cash: 200 + 20 * i,
      retainedEarnings: 900 + 100 * i,
      totalEquity: 1100 + 100 * i,
      cfo: (100 + 15 * i) * 1.3,
      fcf: 150 + 15 * i,
      dividendsPaid: -(30 + 3 * i),
    }),
  );
}

export interface World {
  asOf: ISODate;
  histories: Map<number, InstrumentHistory>;
  instruments: WatchInstrument[];
  portfolio: PortfolioState;
  specs: NameSpec[];
}

export const DEFAULT_NAMES: NameSpec[] = [
  {
    id: 1,
    market: 'US',
    symbol: 'AAA',
    sector: 'Technology',
    seed: 1,
    drift: 0.0006,
    chain: 'bs',
    chainSigma: 0.42,
    earnings: '2026-12-15',
  },
  {
    id: 2,
    market: 'US',
    symbol: 'BBB',
    sector: 'Healthcare',
    seed: 2,
    drift: 0.0005,
    chain: 'bs',
    chainSigma: 0.4,
    earnings: '2026-12-10',
  },
  {
    id: 3,
    market: 'HK',
    symbol: '0700',
    sector: 'Communication Services',
    multiplier: 100,
    seed: 3,
    drift: 0.0005,
    chain: 'csv',
    chainSigma: 0.38,
    earnings: '2026-12-20',
  },
  {
    id: 4,
    market: 'HK',
    symbol: '0005',
    sector: 'Financial Services',
    solvencyModel: 'financial',
    multiplier: 400,
    seed: 4,
    drift: 0.0004,
    chain: 'none',
    earnings: null,
  },
];

export function buildWorld(
  o: {
    asOf?: ISODate;
    specs?: NameSpec[];
    equity?: number | null;
    paramsMutate?: (p: ReturnType<typeof defaultParams>) => void;
  } = {},
): World {
  const asOf = o.asOf ?? WORLD_END;
  const specs = o.specs ?? DEFAULT_NAMES;
  const histories = new Map<number, InstrumentHistory>();
  const instruments: WatchInstrument[] = [];
  for (const s of specs) {
    const market = s.market;
    const total = 700 + (s.futureBars ?? 0);
    const closes = walkCloses({
      n: total,
      start: s.start ?? 60,
      drift: s.drift ?? 0.0004,
      vol: s.vol ?? 0.014,
      seed: s.seed ?? s.id,
    });
    // bars end futureBars trading days after asOf (and staleBy days earlier for stale-data scenarios)
    const barEnd = addDaysTrading(market, asOf, (s.futureBars ?? 0) - (s.staleBy ?? 0));
    const allBars = barsFromCloses(closes, barEnd, market, { volume: 1_000_000 });
    const idxCloses = walkCloses({
      n: total,
      start: 400,
      drift: 0.0003,
      vol: 0.008,
      seed: 90 + (market === 'US' ? 0 : 1),
    });
    const idxEnd = addDaysTrading(market, asOf, s.futureBars ?? 0);
    const indexBars = barsFromCloses(idxCloses, idxEnd, market, { volume: 5_000_000 });
    const volCloses = Array.from({ length: total }, (_, i) => 17 + 4 * Math.sin(i / 25));
    const volBars = s.volIndex === false ? [] : barsFromCloses(volCloses, idxEnd, market, { volume: 0 });
    const inst: WatchInstrument = {
      id: s.id,
      market,
      symbol: s.symbol,
      name: `${s.symbol} Corp`,
      currency: market === 'US' ? 'USD' : 'HKD',
      sector: s.sector ?? null,
      industry: null,
      solvencyModel: s.solvencyModel ?? 'altman',
      reportingFrequency: market === 'US' ? 'quarterly' : 'semiannual',
      benchmarkInstrumentId: null,
      multiplier: s.multiplier ?? 100,
      hasListedOptions: true,
      providerSymbols: {},
      conviction: s.conviction ?? null,
      maxCollateralPct: null,
    };
    instruments.push(inst);
    const spotAt = allBars.filter((b) => b.day <= asOf).at(-1)?.close ?? 100;
    const chains: OptionChainSnapshot[] = [];
    if (s.chain && s.chain !== 'none') {
      const expiries = targetExpiries(market, asOf, market === 'HK' ? 20 : 30, 45);
      if (expiries.length > 0) {
        chains.push(
          bsChain({
            spot: spotAt,
            snapshotDate: addDays(asOf, -(s.chainAgeDays ?? 0)),
            sigma: s.chainSigma ?? 0.35,
            expiries,
            multiplier: inst.multiplier,
            source: s.chain === 'csv' ? 'csv' : 'yahoo',
            spreadPct: 0.05,
            oi: 400,
          }),
        );
      }
    }
    const events: CorporateEvent[] = s.earnings
      ? [
          {
            type: 'earnings',
            date: s.earnings,
            confirmed: true,
            source: 'manual',
            knownAt: '2026-08-01T00:00:00.000Z',
            details: null,
          },
        ]
      : [];
    const history: InstrumentHistory = {
      instrument: inst,
      bars: allBars,
      indexSymbol: market === 'US' ? 'SPY' : '2800',
      indexBars,
      volIndexSymbol: market === 'US' ? 'VIX' : 'VHSI',
      volIndexBars: volBars,
      statements: improvingAnnuals(s.annuals ?? 6).map((st) => ({ ...st, currency: inst.currency })),
      events,
      ivPoints: [],
      chainAsOf: async (d) =>
        chains.filter((c) => c.snapshotDate <= d).sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))[0] ??
        null,
      fx: { USDHKD: fxSeries(asOf, 7.8, 40), CNYHKD: fxSeries(asOf, 1.17, 40) },
      calibration: [],
      journal: [],
    };
    histories.set(s.id, history);
  }
  const params = defaultParams();
  o.paramsMutate?.(params);
  return {
    asOf,
    histories,
    instruments,
    specs,
    portfolio: {
      baseCurrency: 'HKD',
      equity: o.equity === undefined ? 20_000_000 : o.equity,
      openPositions: [],
      fxToBase: (c) => (c === 'HKD' ? 1 : c === 'USD' ? 7.8 : null),
    },
  };
}

function addDaysTrading(market: Market, from: ISODate, n: number): ISODate {
  if (n === 0) return from;
  if (n < 0) return tradingDaysEnding(market, from, -n + 1)[0] as ISODate;
  let d = from;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (tradingDaysEnding(market, d, 1)[0] === d) left--;
  }
  return d;
}

function fxSeries(end: ISODate, base: number, n: number): { day: ISODate; rate: number }[] {
  const r = rng(5);
  return Array.from({ length: n }, (_, i) => ({
    day: addDays(end, -(n - 1 - i)),
    rate: base * (1 + (r() - 0.5) * 0.002),
  }));
}

// ---------------------------------------------------------------- in-memory runner ports
export interface MemoryPorts {
  ports: RunnerPorts;
  cache: Map<string, SkillResult>;
  puts: { instrumentId: number; skillId: string }[];
  gets: { instrumentId: number; skillId: string; hit: boolean }[];
  loads: Map<number, number>;
}

export function memoryPorts(histories: Map<number, InstrumentHistory>, shared?: Map<string, SkillResult>): MemoryPorts {
  const cache = shared ?? new Map<string, SkillResult>();
  const puts: MemoryPorts['puts'] = [];
  const gets: MemoryPorts['gets'] = [];
  const loads = new Map<number, number>();
  let t = 0;
  const key = (i: number, asOf: string, skill: string, version: string, hash: string) =>
    `${i}|${asOf}|${skill}|${version}|${hash}`;
  return {
    cache,
    puts,
    gets,
    loads,
    ports: {
      async loadHistory(id) {
        loads.set(id, (loads.get(id) ?? 0) + 1);
        const h = histories.get(id);
        if (!h) throw new Error(`no history for ${id}`);
        return h;
      },
      async cacheGet(i, asOf, skill, version, hash) {
        const r = cache.get(key(i, asOf, skill, version, hash)) ?? null;
        gets.push({ instrumentId: i, skillId: skill, hit: r !== null });
        return r ? (JSON.parse(JSON.stringify(r)) as SkillResult) : null;
      },
      async cachePut(i, asOf, hash, result) {
        puts.push({ instrumentId: i, skillId: result.skillId });
        cache.set(
          key(i, asOf, result.skillId, result.version, hash),
          JSON.parse(JSON.stringify(result)) as SkillResult,
        );
      },
      timer: () => t++,
    },
  };
}

export type { CalibrationRow, JournalOutcome };
export { createDataAccess };
