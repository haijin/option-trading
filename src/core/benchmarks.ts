import type { Currency, Market } from './types';

/**
 * Index and vol-index instruments that every scan depends on. They are stored as instruments with sector = 'INDEX'.
 * `yahoo` is the provider symbol; VHSI has no daily history on Yahoo (verified 2026-10-10: a spot quote only), so it
 * is fed from an optional CSV seed (data/vhsi.csv) and its absence puts the HK regime in `regime.noVolIndex` mode.
 */
export interface IndexSpec {
  market: Market;
  symbol: string;
  name: string;
  currency: Currency;
  yahoo: string | null;
  role: 'benchmark' | 'reference' | 'vol';
}

export const INDEX_SPECS: readonly IndexSpec[] = [
  { market: 'US', symbol: 'SPY', name: 'SPDR S&P 500 ETF', currency: 'USD', yahoo: 'SPY', role: 'benchmark' },
  { market: 'US', symbol: 'VIX', name: 'Cboe Volatility Index', currency: 'USD', yahoo: '^VIX', role: 'vol' },
  {
    market: 'HK',
    symbol: '2800',
    name: 'Tracker Fund of Hong Kong',
    currency: 'HKD',
    yahoo: '2800.HK',
    role: 'benchmark',
  },
  { market: 'HK', symbol: 'HSI', name: 'Hang Seng Index', currency: 'HKD', yahoo: '^HSI', role: 'reference' },
  { market: 'HK', symbol: 'VHSI', name: 'Hang Seng Volatility Index', currency: 'HKD', yahoo: null, role: 'vol' },
];

export const BENCHMARK_SYMBOL: Record<Market, string> = { US: 'SPY', HK: '2800' };
export const VOL_INDEX_SYMBOL: Record<Market, string> = { US: 'VIX', HK: 'VHSI' };

export const FX_PAIR = 'USDHKD';
/** Yahoo quotes HKD per 1 USD under HKD=X. */
export const FX_YAHOO_SYMBOL = 'HKD=X';
