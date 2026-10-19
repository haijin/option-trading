import type { Market } from '../../src/server/api-types';
import { HK_LOTS, US_DIR } from './seed-ref';

export type ParsedSymbol =
  | { ok: true; market: Market; symbol: string; yahoo: string }
  | { ok: false; market: Market | null; symbol: null; error: string };

function canonHk(raw: string, s: string): ParsedSymbol {
  const digits = s.replace(/\.HK$/, '').replace(/^HK\./, '');
  if (!/^\d{1,5}$/.test(digits)) {
    return {
      ok: false,
      market: 'HK',
      symbol: null,
      error: `invalid HK symbol "${raw}": expected digits such as 700 or 0700.HK`,
    };
  }
  const symbol = digits.replace(/^0+(?=\d)/, '').padStart(4, '0');
  if (symbol === '0000')
    return { ok: false, market: 'HK', symbol: null, error: `invalid HK symbol "${raw}": 0000 is not a stock code` };
  return { ok: true, market: 'HK', symbol, yahoo: `${symbol}.HK` };
}

function canonUs(raw: string, s: string): ParsedSymbol {
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) {
    return {
      ok: false,
      market: 'US',
      symbol: null,
      error: `invalid US symbol "${raw}": letters, digits, '.' or '-', 1 to 10 characters, starting with a letter`,
    };
  }
  const symbol = s.replace('-', '.');
  return { ok: true, market: 'US', symbol, yahoo: symbol.replace('.', '-') };
}

/** The CLI's canonicalSymbol(): HK digits are zero-padded to 4, `.HK` and `HK:` / `US:` prefixes are understood. */
export function parseSymbol(raw: string, forced?: Market | 'auto' | null): ParsedSymbol {
  const t = raw.trim();
  if (!t) return { ok: false, market: null, symbol: null, error: 'Enter a symbol.' };
  let market: Market | null = forced && forced !== 'auto' ? forced : null;
  const s = t.toUpperCase().replace(/^(US|HK)[:.]/, (_m, p: string) => {
    market = market ?? (p as Market);
    return '';
  });
  if (!market) market = /^\d{1,5}(\.HK)?$/.test(s) || /\.HK$/.test(s) ? 'HK' : 'US';
  return market === 'HK' ? canonHk(raw, s) : canonUs(raw, s);
}

/** Name from the lot file or the US directory, if the symbol is known there. */
export function directoryName(market: Market, symbol: string): string | null {
  return market === 'HK' ? (HK_LOTS[symbol]?.[1] ?? null) : (US_DIR[symbol]?.[0] ?? null);
}

export function directorySector(market: Market, symbol: string): string | null {
  return market === 'US' ? (US_DIR[symbol]?.[1] ?? null) : null;
}

export const marketCurrency = (market: Market): 'USD' | 'HKD' => (market === 'US' ? 'USD' : 'HKD');
