import type { PageId } from '../lib/route';
import type { IconName } from './Icon';

export interface NavItem {
  id: PageId;
  icon: IconName;
  label: string;
  short: string;
}

/**
 * The phone tab bar: five tabs. Reminders sits behind the bell in the top bar; everything else is in the More sheet
 * (`MORE_ITEMS`). The desktop rail lists every page (`RAIL_ITEMS`).
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', icon: 'home', label: 'Home', short: 'Home' },
  { id: 'puts', icon: 'puts', label: 'Puts', short: 'Puts' },
  { id: 'leaders', icon: 'leaders', label: 'Leaders', short: 'Leaders' },
  { id: 'news', icon: 'news', label: 'News', short: 'News' },
  { id: 'research', icon: 'research', label: 'Research', short: 'Research' },
];

/** The pages behind the More button, with the one line the sheet shows under each name. */
export const MORE_ITEMS: (NavItem & { sub: string })[] = [
  {
    id: 'watchlist',
    icon: 'watchlist',
    label: 'Watchlist',
    short: 'Watch',
    sub: 'The stocks the scan reads, with KPIs and the verdict',
  },
  {
    id: 'positions',
    icon: 'positions',
    label: 'Positions',
    short: 'Positions',
    sub: 'Open puts, marks, alerts and the wheel lots',
  },
  { id: 'journal', icon: 'journal', label: 'Journal', short: 'Journal', sub: 'The daily diary and the AI rewrite' },
  {
    id: 'backtests',
    icon: 'backtests',
    label: 'Backtests',
    short: 'Tests',
    sub: 'Replay the sell-put rules over past years',
  },
  { id: 'data', icon: 'data', label: 'Data', short: 'Data', sub: 'Ingest, chains, statements and provider status' },
  {
    id: 'settings',
    icon: 'settings',
    label: 'Settings',
    short: 'Settings',
    sub: 'Equity, parameters, theme and the login',
  },
];

/** The desktop rail: the tabs, then Reminders, then the More pages. */
export const RAIL_ITEMS: NavItem[] = [
  ...NAV_ITEMS,
  { id: 'reminders', icon: 'bell', label: 'Reminders', short: 'Remind' },
  ...MORE_ITEMS.map(({ sub: _sub, ...item }) => item),
];
