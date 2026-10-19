import type { Market, StockKey } from '../api/types';

export function isMarket(value: unknown): value is Market {
  return value === 'US' || value === 'HK';
}

/** Stable map/React key for a stock. */
export function stockKey(market: Market, symbol: string): string {
  return `${market}:${symbol}`;
}

export function parseStockKey(key: string): StockKey | null {
  const index = key.indexOf(':');
  if (index < 0) return null;
  const market = key.slice(0, index);
  const symbol = key.slice(index + 1);
  return isMarket(market) && symbol ? { market, symbol } : null;
}

export function sameStock(a: StockKey, b: StockKey): boolean {
  return a.market === b.market && a.symbol === b.symbol;
}

/** Splits pasted text on whitespace, commas and semicolons; drops blanks and exact duplicates, keeps order. */
export function tokenizeSymbols(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** Whether free text looks like a Hong Kong code (700, 0700, 0700.HK, HK:0700) so the UI can hint the market. */
export function looksLikeHk(raw: string): boolean {
  const text = raw.trim().toUpperCase();
  return /^HK[:.]/.test(text) || /\.HK$/.test(text) || /^\d{1,5}$/.test(text);
}

/** Short yahoo-style label for a stock, e.g. "0700.HK" / "KO". */
export function tickerLabel(market: Market, symbol: string): string {
  return market === 'HK' ? `${symbol}.HK` : symbol;
}
