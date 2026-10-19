/**
 * The news fetcher: Yahoo Finance headlines per watched ticker, HKEXnews announcement titles per HK stock code, and a few
 * market-wide feeds. Free sources only. Every feed is isolated (one that fails never aborts the others), and replayable
 * through an injected fetch (tests use src/providers/http-replay.ts fixtures, never the network).
 */
import type { Market } from '../../core/calendar';
import { fetchHkexAnnouncements } from './hkex';
import { getText } from './http';
import { parseRss } from './rss';
import type { FetchedNews, NewsFetchResult } from './types';
import { fetchYahooRss, storyTime, YAHOO_SOURCE, yahooSymbolFor } from './yahoo-rss';

export type { FetchedNews, NewsFetchResult } from './types';

export interface NewsName {
  market: Market;
  symbol: string;
  /** Yahoo spelling when the instrument overrides it (`providerSymbols.yahoo`). */
  yahoo?: string;
}

/** Market-wide feeds: index headlines from Yahoo Finance and the CNBC markets feed. */
export type MarketFeed =
  | { id: string; kind: 'yahoo'; symbol: string }
  | { id: string; kind: 'rss'; url: string; source: string };

export const MARKET_FEEDS: readonly MarketFeed[] = [
  { id: 'yahoo-gspc', kind: 'yahoo', symbol: '^GSPC' },
  { id: 'yahoo-ixic', kind: 'yahoo', symbol: '^IXIC' },
  { id: 'yahoo-hsi', kind: 'yahoo', symbol: '^HSI' },
  { id: 'cnbc-markets', kind: 'rss', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC' },
];

const CONCURRENCY = 4;

async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      for (let i = next++; i < tasks.length; i = next++) {
        try {
          out[i] = { status: 'fulfilled', value: await (tasks[i] as () => Promise<T>)() };
        } catch (reason) {
          out[i] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return out;
}

async function fetchMarketFeed(fetchFn: typeof fetch, feed: MarketFeed, now: Date): Promise<FetchedNews[]> {
  if (feed.kind === 'yahoo') return fetchYahooRss(fetchFn, feed.symbol, null, now);
  const xml = await getText(fetchFn, feed.id, feed.id, feed.url, 'application/rss+xml, text/xml');
  return parseRss(xml).map((i) => ({
    source: feed.source,
    url: i.link,
    title: i.title,
    snippet: i.description,
    publishedAt: storyTime(i.pubDate, now),
    target: null,
  }));
}

/** Fetches every feed for the given names. Per-name feeds first, so a story keeps its name when a market feed repeats it. */
export async function collectNews(opts: {
  fetch: typeof fetch;
  now: Date;
  names: readonly NewsName[];
  /** Set false to skip the market-wide feeds. */
  marketFeeds?: boolean;
}): Promise<NewsFetchResult> {
  const { fetch: f, now } = opts;
  const labels: string[] = [];
  const tasks: (() => Promise<FetchedNews[]>)[] = [];
  for (const n of opts.names) {
    const target = { market: n.market, symbol: n.symbol };
    labels.push(`${YAHOO_SOURCE} ${n.market}:${n.symbol}`);
    tasks.push(() => fetchYahooRss(f, n.yahoo ?? yahooSymbolFor(n.market, n.symbol), target, now));
    if (n.market === 'HK') {
      labels.push(`HKEXnews ${n.symbol}`);
      tasks.push(() => fetchHkexAnnouncements(f, n.symbol, now));
    }
  }
  if (opts.marketFeeds !== false) {
    for (const feed of MARKET_FEEDS) {
      labels.push(`market feed ${feed.id}`);
      tasks.push(() => fetchMarketFeed(f, feed, now));
    }
  }
  const settled = await pool(tasks, CONCURRENCY);
  const items: FetchedNews[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(`${labels[i]}: ${(r.reason as Error).message}`);
  });
  return { items, errors, feeds: tasks.length };
}
