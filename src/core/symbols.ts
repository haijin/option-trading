import type { Market } from './calendar';
import type { Currency } from './types';

/** Canonical symbol: US upper-case ('BRK.B'), HK four-digit zero-padded digits ('0700'). */
export function canonicalSymbol(market: Market, raw: string): string {
  const s = raw.trim().toUpperCase();
  if (market === 'HK') {
    const digits = s.replace(/\.HK$/, '').replace(/^HK\./, '');
    if (!/^\d{1,5}$/.test(digits))
      throw new Error(`invalid HK symbol "${raw}": expected digits such as 700 or 0700.HK`);
    return digits.replace(/^0+(?=\d)/, '').padStart(4, '0');
  }
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) throw new Error(`invalid US symbol "${raw}"`);
  return s.replace('-', '.');
}

/** Yahoo Finance symbol: `0700.HK`, `BRK-B`. Index specs carry their own Yahoo symbol. */
export function yahooSymbol(market: Market, symbol: string): string {
  return market === 'HK' ? `${symbol}.HK` : symbol.replace('.', '-');
}

export function currencyOf(market: Market): Currency {
  return market === 'HK' ? 'HKD' : 'USD';
}

export function defaultMultiplier(market: Market, boardLot?: number): number {
  return market === 'HK' ? (boardLot ?? 100) : 100;
}
