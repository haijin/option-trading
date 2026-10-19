import type { Market } from '../../core/calendar';

/** One story as a feed delivered it, before it is stored. */
export interface FetchedNews {
  /** 'Yahoo Finance', 'HKEXnews', 'CNBC': what the page prints as the source. */
  source: string;
  url: string;
  title: string;
  snippet: string | null;
  publishedAt: Date;
  /** The watched name this feed was asked about; null for a market-wide feed. */
  target: { market: Market; symbol: string } | null;
}

export interface NewsFetchResult {
  items: FetchedNews[];
  /** One line per feed that failed; the others still count. */
  errors: string[];
  /** How many feeds were asked. */
  feeds: number;
}
