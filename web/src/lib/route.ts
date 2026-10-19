import type { Market } from '../api/types';
import { isMarket } from './symbols';

/**
 * Every page the router knows. `backtests` has no tab or rail entry (layout/nav.ts): it is reached from the "More"
 * sheet and the "More pages" panel in Settings. `puts` is the former Today page; `#/today` still parses as an alias.
 */
export type PageId =
  | 'home'
  | 'puts'
  | 'journal'
  | 'research'
  | 'news'
  | 'leaders'
  | 'watchlist'
  | 'positions'
  | 'reminders'
  | 'backtests'
  | 'data'
  | 'settings';

export interface Route {
  page: PageId;
  market?: Market;
  symbol?: string;
  /** Journal only: the entry that is open (`YYYY-MM-DD`). Absent on the list. */
  date?: string;
}

export const PAGE_IDS: readonly PageId[] = [
  'home',
  'puts',
  'journal',
  'research',
  'news',
  'leaders',
  'watchlist',
  'positions',
  'reminders',
  'backtests',
  'data',
  'settings',
];
export const DEFAULT_ROUTE: Route = { page: 'home' };

export const PAGE_TITLES: Record<PageId, string> = {
  home: 'Home',
  puts: 'Puts',
  journal: 'Journal',
  research: 'Research',
  news: 'News',
  leaders: 'Leaders',
  watchlist: 'Watchlist',
  positions: 'Positions',
  reminders: 'Reminders',
  backtests: 'Backtests',
  data: 'Data',
  settings: 'Settings',
};

/** Old page names that still open something: `#/today/US/KO` is `#/puts/US/KO`. */
const ALIASES: Record<string, PageId> = { today: 'puts' };

/** Pages whose route may carry a selected stock: `#/research/US/KO`. */
const STOCK_PAGES: ReadonlySet<PageId> = new Set<PageId>(['puts', 'research', 'watchlist']);

function isPage(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value);
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A real calendar day written `YYYY-MM-DD` (2026-02-30 is not one). */
export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Parses `location.hash`. Anything unknown falls back to Home. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter((part) => part !== '');
  const [pageInput, marketRaw, symbolRaw] = parts;
  const pageRaw = pageInput ? (ALIASES[pageInput] ?? pageInput) : undefined;
  if (!pageRaw || !isPage(pageRaw)) return { ...DEFAULT_ROUTE };
  if (pageRaw === 'journal') {
    // `#/journal/2026-10-13` opens that day; a malformed or impossible date falls back to the list.
    return marketRaw && isIsoDay(marketRaw) ? { page: 'journal', date: marketRaw } : { page: 'journal' };
  }
  if (STOCK_PAGES.has(pageRaw) && marketRaw && symbolRaw) {
    const market = marketRaw.toUpperCase();
    const symbol = safeDecode(symbolRaw).trim().toUpperCase();
    if (isMarket(market) && symbol) return { page: pageRaw, market, symbol };
  }
  return { page: pageRaw };
}

export function toHash(route: Route): string {
  const base = `#/${route.page}`;
  if (route.page === 'journal') return route.date && isIsoDay(route.date) ? `${base}/${route.date}` : base;
  if (STOCK_PAGES.has(route.page) && route.market && route.symbol) {
    return `${base}/${route.market}/${encodeURIComponent(route.symbol)}`;
  }
  return base;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.page === b.page && a.market === b.market && a.symbol === b.symbol && a.date === b.date;
}
