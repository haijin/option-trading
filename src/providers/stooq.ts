/**
 * Stooq daily-bar fallback (T15): a plain CSV URL, no auth. Used only when Yahoo fails for a symbol.
 *
 * Since late 2025 Stooq answers automated requests with an HTML "verify your browser" page that needs a JavaScript
 * proof-of-work to pass. This adapter does NOT solve it (that would be bot-detection bypass): it recognises the page
 * and fails with code `challenge`, so ingest records the outage instead of storing garbage. Stooq CSVs carry no
 * adjusted close, so `adjClose = close`; ingest therefore only appends days newer than the stored history.
 */
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { DailyBar } from '../core/types';
import { ProviderError } from './yahoo/client';

export function stooqSymbol(market: Market, symbol: string): string {
  return market === 'HK' ? `${symbol.toLowerCase()}.hk` : `${symbol.toLowerCase().replace('.', '-')}.us`;
}

export function stooqUrl(market: Market, symbol: string, from: ISODate, to: ISODate): string {
  const compact = (d: ISODate) => d.replace(/-/g, '');
  return `https://stooq.com/q/d/l/?s=${stooqSymbol(market, symbol)}&d1=${compact(from)}&d2=${compact(to)}&i=d`;
}

export type StooqFailure = 'challenge' | 'no_data' | 'rate_limit' | 'bad_format';

function fail(symbol: string, code: StooqFailure, message: string): never {
  throw new ProviderError('stooq', symbol, message, code);
}

export function parseStooqCsv(text: string, symbol: string): DailyBar[] {
  const body = text.replace(/^﻿/, '').trim();
  if (/^<!doctype|^<html|verify your browser|requires javascript/i.test(body.slice(0, 600))) {
    fail(symbol, 'challenge', 'Stooq served a JavaScript browser-verification page instead of CSV');
  }
  if (/exceeded the daily hits limit/i.test(body)) fail(symbol, 'rate_limit', 'Stooq daily hit limit exceeded');
  if (body === '' || /^no data/i.test(body)) fail(symbol, 'no_data', 'Stooq has no data for this symbol');
  const lines = body.split(/\r?\n/);
  const header = (lines[0] ?? '').toLowerCase().split(',');
  const col = (name: string) => header.indexOf(name);
  const [iDate, iOpen, iHigh, iLow, iClose, iVol] = ['date', 'open', 'high', 'low', 'close', 'volume'].map(
    col,
  ) as number[];
  if ([iDate, iOpen, iHigh, iLow, iClose].some((i) => (i ?? -1) < 0)) {
    fail(symbol, 'bad_format', `unexpected header "${lines[0]}"`);
  }
  const bars: DailyBar[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    const day = c[iDate as number] ?? '';
    const [open, high, low, close] = [iOpen, iHigh, iLow, iClose].map((i) => Number(c[i as number]));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      [open, high, low, close].some((n) => !Number.isFinite(n)) ||
      (close as number) <= 0
    ) {
      continue;
    }
    const volume = iVol !== undefined && iVol >= 0 ? Math.max(0, Math.round(Number(c[iVol]) || 0)) : 0;
    bars.push({
      day,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      adjClose: close as number,
      volume,
      source: 'stooq',
    });
  }
  if (bars.length === 0) fail(symbol, 'bad_format', 'CSV contained no usable rows');
  return bars.sort((a, b) => a.day.localeCompare(b.day));
}

export async function fetchStooqBars(
  fetchFn: typeof fetch,
  market: Market,
  symbol: string,
  from: ISODate,
  to: ISODate,
): Promise<DailyBar[]> {
  const res = await fetchFn(stooqUrl(market, symbol, from, to), { headers: { 'user-agent': 'option-trading/0.1' } });
  const text = await res.text();
  if (!res.ok && !/<html/i.test(text)) fail(symbol, 'bad_format', `HTTP ${res.status}`);
  return parseStooqCsv(text, symbol);
}
