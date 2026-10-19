import { describe, expect, it } from 'vitest';
import { isMarket, looksLikeHk, parseStockKey, sameStock, stockKey, tickerLabel, tokenizeSymbols } from './symbols';

describe('symbols', () => {
  it('builds and parses stock keys', () => {
    expect(stockKey('US', 'KO')).toBe('US:KO');
    expect(parseStockKey('HK:0700')).toEqual({ market: 'HK', symbol: '0700' });
    expect(parseStockKey('EU:XYZ')).toBeNull();
    expect(parseStockKey('nokey')).toBeNull();
    expect(sameStock({ market: 'US', symbol: 'KO' }, { market: 'US', symbol: 'KO' })).toBe(true);
    expect(isMarket('HK')).toBe(true);
    expect(isMarket('hk')).toBe(false);
  });

  it('tokenises pasted lists on whitespace, commas and semicolons without duplicates', () => {
    expect(tokenizeSymbols('AAPL, MSFT\n0005;3690.HK  AAPL')).toEqual(['AAPL', 'MSFT', '0005', '3690.HK']);
    expect(tokenizeSymbols('  \n ,, ')).toEqual([]);
  });

  it('recognises Hong Kong style input', () => {
    expect(looksLikeHk('700')).toBe(true);
    expect(looksLikeHk('0700.HK')).toBe(true);
    expect(looksLikeHk('HK:0005')).toBe(true);
    expect(looksLikeHk('AAPL')).toBe(false);
    expect(tickerLabel('HK', '0700')).toBe('0700.HK');
    expect(tickerLabel('US', 'KO')).toBe('KO');
  });
});
