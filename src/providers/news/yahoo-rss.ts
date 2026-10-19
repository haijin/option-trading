import type { Market } from '../../core/calendar';
import { yahooSymbol } from '../../core/symbols';
import { getText } from './http';
import { parseRss } from './rss';
import type { FetchedNews } from './types';

export const YAHOO_RSS_URL = 'https://feeds.finance.yahoo.com/rss/2.0/headline';
export const YAHOO_SOURCE = 'Yahoo Finance';

/** Yahoo's per-ticker headline feed. `symbol` is the Yahoo spelling: `NKE`, `0700.HK`, `^GSPC`. */
export function yahooRssUrl(symbol: string): string {
  return `${YAHOO_RSS_URL}?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
}

/** A story dated in the future is bad data; one with no date is dated when we first saw it. */
export function storyTime(pub: Date | null, now: Date): Date {
  return pub === null || pub.getTime() > now.getTime() + 3_600_000 ? now : pub;
}

/** Headlines for one watched name (`target`), or for an index when `target` is null. */
export async function fetchYahooRss(
  fetchFn: typeof fetch,
  yahooSym: string,
  target: { market: Market; symbol: string } | null,
  now: Date,
): Promise<FetchedNews[]> {
  const xml = await getText(fetchFn, 'yahoo-rss', yahooSym, yahooRssUrl(yahooSym), 'application/rss+xml, text/xml');
  return parseRss(xml).map((i) => ({
    source: YAHOO_SOURCE,
    url: i.link,
    title: i.title,
    snippet: i.description,
    publishedAt: storyTime(i.pubDate, now),
    target,
  }));
}

export const yahooSymbolFor = (market: Market, symbol: string): string => yahooSymbol(market, symbol);
