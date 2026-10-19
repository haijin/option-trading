import type { Currency, DeployView, EarningsView, Market, RegimeView } from '../../src/server/api-types';
import { keyOf, type PositionRec, type Profile, type Store, type WatchRow } from './model';
import { HK_LOTS } from './seed-ref';
import { SEED_STOCKS } from './seed-stocks';
import { marketCurrency } from './symbols';
import { ASOF, FX_USD_HKD, HttpError, notFound, round } from './util';

// ------------------------------------------------------------------------------------------------ regimes
export interface Regime extends RegimeView {
  /** Minimum annualised return on collateral for a put, percent. */
  minRoc: number;
}

export const REGIMES: Record<Market, Regime> = {
  US: {
    market: 'US',
    regime: 'bull_calm',
    label: 'bull-calm',
    deployCapPct: 50,
    deltaCap: 0.3,
    minRoc: 12,
    note: 'SPY above its 200d average, VIX 15.8',
    usedVolIndex: true,
  },
  HK: {
    market: 'HK',
    regime: 'bear_calm',
    label: 'bear-calm',
    deployCapPct: 30,
    deltaCap: 0.2,
    minRoc: 10,
    note: 'HSI below its 200d average; no vol index (regime.noVolIndex)',
    usedVolIndex: false,
  },
};

export const PER_NAME_CAP_PCT = 5;

// ------------------------------------------------------------------------------------------------ position maths
export function pnlOf(
  p: Pick<PositionRec, 'openPrice' | 'closePrice' | 'multiplier' | 'quantity' | 'openFees' | 'closeFees'>,
): number {
  return round((p.openPrice - (p.closePrice ?? 0)) * p.multiplier * p.quantity - p.openFees - p.closeFees, 2);
}

function closedSeed(
  id: number,
  symbol: string,
  market: Market,
  o: {
    strike: number;
    expiry: string;
    quantity: number;
    multiplier: number;
    openDate: string;
    openPrice: number;
    closeDate: string;
    closePrice: number;
    status: PositionRec['status'];
    fees?: number;
  },
): PositionRec {
  const rec: PositionRec = {
    id,
    symbol,
    market,
    strike: o.strike,
    expiry: o.expiry,
    quantity: o.quantity,
    multiplier: o.multiplier,
    openDate: o.openDate,
    openPrice: o.openPrice,
    openFees: o.fees ?? 0,
    status: o.status,
    closeDate: o.closeDate,
    closePrice: o.closePrice,
    closeFees: 0,
    realizedPnl: null,
    source: 'journal_import',
    spotHint: null,
  };
  rec.realizedPnl = pnlOf(rec);
  return rec;
}

function openSeed(
  id: number,
  symbol: string,
  market: Market,
  strike: number,
  expiry: string,
  quantity: number,
  multiplier: number,
  openDate: string,
  openPrice: number,
): PositionRec {
  return {
    id,
    symbol,
    market,
    strike,
    expiry,
    quantity,
    multiplier,
    openDate,
    openPrice,
    openFees: 0,
    status: 'open',
    closeDate: null,
    closePrice: null,
    closeFees: 0,
    realizedPnl: null,
    source: 'manual',
    spotHint: null,
  };
}

// ------------------------------------------------------------------------------------------------ the store
function createStore(): Store {
  const watch = new Map<string, WatchRow>();
  for (const { profile, watch: meta } of SEED_STOCKS) {
    watch.set(keyOf(profile.market, profile.symbol), {
      symbol: profile.symbol,
      market: profile.market,
      name: profile.name,
      sector: profile.sector,
      boardLot: profile.market === 'HK' ? (HK_LOTS[profile.symbol]?.[0] ?? 100) : 100,
      solvencyModel: meta.solvency,
      solvencyInferred: false,
      reportingFrequency: profile.market === 'HK' ? 'semiannual' : 'quarterly',
      conviction: meta.conviction,
      notes: meta.notes,
      maxCollateralPct: meta.maxPct,
      active: true,
      addedAt: '2026-09-01T00:00:00.000Z',
      ingest: 'loaded',
      profile,
    });
  }
  const unset = process.env.MOCK_EQUITY_UNSET === '1';
  return {
    equity: unset ? null : 2_000_000,
    baseCurrency: 'HKD',
    watch,
    positions: [
      openSeed(1, 'GOOGL', 'US', 250, '2026-11-20', 1, 100, '2026-10-01', 4.35),
      openSeed(2, '2318', 'HK', 48, '2026-10-29', 2, 500, '2026-09-22', 0.62),
      openSeed(3, 'CRM', 'US', 230, '2026-11-20', 1, 100, '2026-09-30', 3.1),
      closedSeed(4, '0388', 'HK', {
        strike: 355,
        expiry: '2026-09-29',
        quantity: 5,
        multiplier: 100,
        openDate: '2026-09-01',
        openPrice: 5.85,
        closeDate: '2026-09-29',
        closePrice: 0,
        status: 'expired',
        fees: 25,
      }),
      closedSeed(5, 'MSFT', 'US', {
        strike: 440,
        expiry: '2026-09-18',
        quantity: 1,
        multiplier: 100,
        openDate: '2026-08-25',
        openPrice: 5.7,
        closeDate: '2026-09-12',
        closePrice: 2.85,
        status: 'closed',
      }),
      closedSeed(6, '0941', 'HK', {
        strike: 70,
        expiry: '2026-08-28',
        quantity: 5,
        multiplier: 500,
        openDate: '2026-07-31',
        openPrice: 0.74,
        closeDate: '2026-08-28',
        closePrice: 0,
        status: 'expired',
      }),
      closedSeed(7, '1810', 'HK', {
        strike: 52,
        expiry: '2026-09-29',
        quantity: 5,
        multiplier: 200,
        openDate: '2026-09-02',
        openPrice: 0.72,
        closeDate: '2026-09-29',
        closePrice: 4.87,
        status: 'assigned',
      }),
      closedSeed(8, 'KO', 'US', {
        strike: 62,
        expiry: '2026-09-18',
        quantity: 1,
        multiplier: 100,
        openDate: '2026-08-24',
        openPrice: 0.61,
        closeDate: '2026-09-18',
        closePrice: 0,
        status: 'expired',
      }),
    ],
    nextPositionId: 9,
    // Chosen so that, with the five closed trades above, the journal reads 41 trades, 34 wins, HK +128,400, US +6,950.
    journalBase: { trades: 36, wins: 30, realised: { HKD: 127_800, USD: 6_604 } },
    events: new Map([
      [keyOf('US', 'KO'), [{ type: 'ex_dividend', date: '2026-11-28', confirmed: true, source: 'yahoo' }]],
      [keyOf('HK', '0941'), [{ type: 'ex_dividend', date: '2026-11-27', confirmed: false, source: 'estimate' }]],
    ]),
    chains: new Map([
      [
        keyOf('HK', '0388'),
        { source: 'csv', date: ASOF, spot: 402, stored: 48, expiries: ['2026-10-29', '2026-11-27'], iv30: 0.315 },
      ],
    ]),
    overrides: new Map(),
    fairValues: new Map(),
    ingestJobs: [],
    nextIngestId: 1,
    runs: [],
    nextRunId: 1,
    aiFreeAtMs: 0,
    lastScan: { id: 'scan-0007', at: '2026-10-09T10:05:12.000Z', asOf: ASOF, ideas: 7 },
    scanSigs: new Map(),
    nextScanId: 8,
    skillUnavailable: process.env.MOCK_SKILL_UNAVAILABLE === '1',
  };
}

export const store: Store = createStore();

// ------------------------------------------------------------------------------------------------ selectors
export const rows = (): WatchRow[] => [...store.watch.values()];
export const activeRows = (): WatchRow[] => rows().filter((r) => r.active);

export function findRow(market: Market, symbol: string): WatchRow | undefined {
  return store.watch.get(keyOf(market, symbol));
}

export function requireRow(market: Market, symbol: string): WatchRow {
  const row = findRow(market, symbol);
  if (!row) throw notFound(`${market}:${symbol} is not on the watchlist.`);
  return row;
}

export const rowKey = (r: { market: Market; symbol: string }): string => keyOf(r.market, r.symbol);
export const openPositions = (): PositionRec[] => store.positions.filter((p) => p.status === 'open');
export const openFor = (market: Market, symbol: string): PositionRec[] =>
  openPositions().filter((p) => p.market === market && p.symbol === symbol);

/** Latest user-entered earnings date wins over the provider's date. */
export function nextEarnings(market: Market, symbol: string, profile: Profile | null): EarningsView | null {
  const user = (store.events.get(keyOf(market, symbol)) ?? [])
    .filter((e) => e.type === 'earnings' && e.date >= ASOF)
    .at(-1);
  if (user) return { date: user.date, confirmed: user.confirmed, source: user.source };
  return profile?.er ? { date: profile.er.date, confirmed: profile.er.confirmed, source: profile.er.source } : null;
}

// ------------------------------------------------------------------------------------------------ currency
export function toBase(amount: number, from: Currency): number {
  if (from === store.baseCurrency) return amount;
  return from === 'USD' ? amount * FX_USD_HKD : amount / FX_USD_HKD;
}

export const baseSymbol = (): string => (store.baseCurrency === 'HKD' ? 'HK$' : 'US$');
export const currencySymbol = (c: Currency): string => (c === 'HKD' ? 'HK$' : 'US$');

export function requireEquity(): number {
  if (store.equity === null)
    throw new HttpError(409, 'equity_not_set', 'Equity is not set. Set it in Settings before scanning.');
  return store.equity;
}

export function deployView(market: Market): DeployView {
  const amountBase = openPositions()
    .filter((p) => p.market === market)
    .reduce((sum, p) => sum + toBase(p.strike * p.multiplier * p.quantity, marketCurrency(p.market)), 0);
  const capPct = REGIMES[market].deployCapPct;
  const equity = store.equity;
  return {
    amountBase: round(amountBase, 2),
    pctOfEquity: equity ? round((amountBase / equity) * 100, 2) : 0,
    capPct,
    allowedBase: equity ? round((equity * capPct) / 100, 2) : 0,
  };
}

export function regimeView(market: Market): RegimeView {
  const { minRoc: _minRoc, ...view } = REGIMES[market];
  return view;
}
