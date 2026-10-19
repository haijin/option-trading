import { describe, expect, it } from 'vitest';
import { MORE_ITEMS, NAV_ITEMS, RAIL_ITEMS } from '../layout/nav';
import { isIsoDay, PAGE_IDS, PAGE_TITLES, parseHash, sameRoute, toHash } from './route';

describe('route', () => {
  it('defaults to home', () => {
    expect(parseHash('')).toEqual({ page: 'home' });
    expect(parseHash('#')).toEqual({ page: 'home' });
    expect(parseHash('#/nonsense')).toEqual({ page: 'home' });
  });

  it('parses every page', () => {
    for (const page of [
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
    ] as const) {
      expect(parseHash(`#/${page}`)).toEqual({ page });
    }
  });

  it('keeps #/today working as an alias of Puts', () => {
    expect(parseHash('#/today')).toEqual({ page: 'puts' });
    expect(parseHash('#/today/US/KO')).toEqual({ page: 'puts', market: 'US', symbol: 'KO' });
    expect(PAGE_TITLES.puts).toBe('Puts');
    expect(PAGE_IDS).not.toContain('today');
  });

  it('has five tabs, the rest behind the bell and More; the rail lists every page but Backtests stays off the tabs', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual(['home', 'puts', 'leaders', 'news', 'research']);
    expect(MORE_ITEMS.map((item) => item.id)).toEqual([
      'watchlist',
      'positions',
      'journal',
      'backtests',
      'data',
      'settings',
    ]);
    expect(RAIL_ITEMS.map((item) => item.id)).toContain('reminders');
    expect(new Set(RAIL_ITEMS.map((item) => item.id)).size).toBe(RAIL_ITEMS.length);
    for (const id of PAGE_IDS)
      expect([...NAV_ITEMS, ...MORE_ITEMS].some((item) => item.id === id) || id === 'reminders').toBe(true);
    expect(parseHash('#/leaders/US/VRT')).toEqual({ page: 'leaders' });
    expect(parseHash('#/leaders?x=1')).toEqual({ page: 'leaders' });
    expect(toHash({ page: 'leaders', market: 'US', symbol: 'VRT' })).toBe('#/leaders');
  });

  it('parses a selected stock and normalises case', () => {
    expect(parseHash('#/research/US/KO')).toEqual({ page: 'research', market: 'US', symbol: 'KO' });
    expect(parseHash('#/watchlist/hk/0700')).toEqual({ page: 'watchlist', market: 'HK', symbol: '0700' });
    expect(parseHash('#/puts/US/brk.b')).toEqual({ page: 'puts', market: 'US', symbol: 'BRK.B' });
  });

  it('ignores a stock on pages that do not take one, and bad markets', () => {
    expect(parseHash('#/positions/US/KO')).toEqual({ page: 'positions' });
    expect(parseHash('#/news/US/KO')).toEqual({ page: 'news' });
    expect(parseHash('#/home/US/KO')).toEqual({ page: 'home' });
    expect(parseHash('#/research/EU/KO')).toEqual({ page: 'research' });
    expect(parseHash('#/research/US')).toEqual({ page: 'research' });
  });

  it('round-trips through toHash', () => {
    const routes = [
      { page: 'puts' as const },
      { page: 'research' as const, market: 'US' as const, symbol: 'KO' },
      { page: 'watchlist' as const, market: 'HK' as const, symbol: '0700' },
    ];
    for (const route of routes) expect(parseHash(toHash(route))).toEqual(route);
    expect(toHash({ page: 'data', market: 'US', symbol: 'KO' })).toBe('#/data');
  });

  it('parses a journal day and falls back to the list for a bad date', () => {
    expect(parseHash('#/journal')).toEqual({ page: 'journal' });
    expect(parseHash('#/journal/2026-10-13')).toEqual({ page: 'journal', date: '2026-10-13' });
    expect(parseHash('#/journal/2026-10-13?x=1')).toEqual({ page: 'journal', date: '2026-10-13' });
    expect(parseHash('#/journal/2026-02-30')).toEqual({ page: 'journal' });
    expect(parseHash('#/journal/2026-1-3')).toEqual({ page: 'journal' });
    expect(parseHash('#/journal/yesterday')).toEqual({ page: 'journal' });
    expect(parseHash('#/journal/US/KO')).toEqual({ page: 'journal' });
  });

  it('writes and round-trips journal routes, and only the journal carries a date', () => {
    expect(toHash({ page: 'journal' })).toBe('#/journal');
    expect(toHash({ page: 'journal', date: '2026-10-13' })).toBe('#/journal/2026-10-13');
    expect(toHash({ page: 'journal', date: 'nonsense' })).toBe('#/journal');
    expect(toHash({ page: 'puts', date: '2026-10-13' })).toBe('#/puts');
    const route = { page: 'journal' as const, date: '2026-10-13' };
    expect(parseHash(toHash(route))).toEqual(route);
  });

  it('checks calendar days', () => {
    expect(isIsoDay('2026-10-13')).toBe(true);
    expect(isIsoDay('2028-02-29')).toBe(true);
    expect(isIsoDay('2026-02-29')).toBe(false);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('26-10-13')).toBe(false);
  });

  it('compares routes', () => {
    expect(sameRoute({ page: 'puts' }, { page: 'puts' })).toBe(true);
    expect(sameRoute({ page: 'puts' }, { page: 'research' })).toBe(false);
    expect(sameRoute({ page: 'journal' }, { page: 'journal', date: '2026-10-13' })).toBe(false);
    expect(sameRoute({ page: 'journal', date: '2026-10-13' }, { page: 'journal', date: '2026-10-13' })).toBe(true);
  });
});
