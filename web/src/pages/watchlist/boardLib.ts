import type { Market, WatchActionKind, WatchBoardRow } from '../../api/types';

/** What the table is narrowed to. `results_soon` and `below_iv` are the two highlights that are not an action. */
export type BoardFilter = 'all' | WatchActionKind | 'results_soon' | 'below_iv';
export type MarketFilter = 'all' | Market;
export type SortKey = 'action' | 'stock' | 'change' | 'ivRank' | 'roe' | 'fcf' | 'pe' | 'value' | 'earnings';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'action', dir: 'asc' };

/** Same thresholds as the server's summary (src/server/watch-board.ts), so a count and the rows behind it agree. */
export const EARNINGS_SOON_DAYS = 14;
export const UNDERVALUED_RATIO = 0.8;

export const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sell_put', label: 'Sell put' },
  { id: 'wait', label: 'Wait' },
  { id: 'avoid', label: 'Avoid' },
  { id: 'hold', label: 'Open put' },
  { id: 'needs_data', label: 'Needs data' },
  { id: 'results_soon', label: 'Results soon' },
  { id: 'below_iv', label: 'Below IV' },
];

export const isResultsSoon = (row: WatchBoardRow): boolean =>
  row.earningsInDays !== null && row.earningsInDays <= EARNINGS_SOON_DAYS;

export const isBelowIv = (row: WatchBoardRow): boolean =>
  row.value !== null && row.value.priceRatio <= UNDERVALUED_RATIO;

function matchesFilter(row: WatchBoardRow, filter: BoardFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'results_soon') return isResultsSoon(row);
  if (filter === 'below_iv') return isBelowIv(row);
  return row.action.kind === filter;
}

export function filterRows(
  rows: readonly WatchBoardRow[],
  by: { filter: BoardFilter; market: MarketFilter; query: string },
): WatchBoardRow[] {
  const q = by.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      matchesFilter(row, by.filter) &&
      (by.market === 'all' || row.market === by.market) &&
      (q === '' || row.symbol.toLowerCase().includes(q) || (row.name ?? '').toLowerCase().includes(q)),
  );
}

/** How many rows each filter chip would show, over the rows already narrowed by market and search. */
export function filterCounts(rows: readonly WatchBoardRow[]): Record<BoardFilter, number> {
  const out = {} as Record<BoardFilter, number>;
  for (const f of FILTERS) out[f.id] = rows.filter((row) => matchesFilter(row, f.id)).length;
  return out;
}

const ACTION_ORDER: Record<WatchActionKind, number> = { sell_put: 0, wait: 1, avoid: 2, hold: 3, needs_data: 4 };
const MAX = Number.MAX_SAFE_INTEGER;

/** Every column compares as a number, except the stock column (text). Null means "no value" and always sorts last. */
function sortValue(row: WatchBoardRow, key: SortKey): number | string | null {
  switch (key) {
    case 'action':
      return ACTION_ORDER[row.action.kind] * 1_000 + Math.min(row.rank ?? 999, 999);
    case 'stock':
      return row.symbol;
    case 'change':
      return row.changePct;
    case 'ivRank':
      return row.ivRank;
    case 'roe':
      return row.roePct;
    case 'fcf':
      return row.fcfYieldPct;
    case 'pe':
      return row.pe !== null && row.pe > 0 ? row.pe : null;
    case 'value':
      return row.value?.priceRatio ?? null;
    case 'earnings':
      return row.earningsInDays;
  }
}

/** A new column starts in the direction most people want from it: best first. */
const FIRST_DIR: Record<SortKey, SortState['dir']> = {
  action: 'asc',
  stock: 'asc',
  change: 'desc',
  ivRank: 'desc',
  roe: 'desc',
  fcf: 'desc',
  pe: 'asc',
  value: 'asc',
  earnings: 'asc',
};

/** A column picked from the phone's sort menu starts in its best-first direction. */
export const sortFor = (key: SortKey): SortState => ({ key, dir: FIRST_DIR[key] });

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: FIRST_DIR[key] };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'action', label: 'Recommendation' },
  { id: 'stock', label: 'Stock' },
  { id: 'change', label: 'Day change' },
  { id: 'ivRank', label: 'IV rank' },
  { id: 'roe', label: 'ROE' },
  { id: 'fcf', label: 'FCF yield' },
  { id: 'pe', label: 'P/E' },
  { id: 'value', label: 'Price vs IV' },
  { id: 'earnings', label: 'Next results' },
];

export function sortRows(rows: readonly WatchBoardRow[], sort: SortState): WatchBoardRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && y !== null && x !== y) {
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      if (c !== 0) return c * sign;
    }
    // ties: the server's default order (market, then symbol), whatever the direction
    return a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol);
  });
}

/** The three lines under the summary tiles. */
export function headlines(rows: readonly WatchBoardRow[]): {
  best: WatchBoardRow | null;
  soon: WatchBoardRow[];
  cheap: WatchBoardRow[];
} {
  const ideas = rows.filter((r) => r.action.kind === 'sell_put' && r.put !== null);
  const best = ideas.reduce<WatchBoardRow | null>(
    (top, r) => (top === null || (r.composite ?? -MAX) > (top.composite ?? -MAX) ? r : top),
    null,
  );
  return {
    best,
    soon: rows.filter(isResultsSoon).sort((a, b) => (a.earningsInDays ?? MAX) - (b.earningsInDays ?? MAX)),
    cheap: rows.filter(isBelowIv).sort((a, b) => (a.value?.priceRatio ?? MAX) - (b.value?.priceRatio ?? MAX)),
  };
}

export interface BoardSummary {
  watching: number;
  us: number;
  hk: number;
  sellPut: number;
  wait: number;
  avoid: number;
  hold: number;
  needsData: number;
  earningsSoon: number;
  undervalued: number;
}

/** The tile numbers, counted from the rows on screen so a name just stopped does not linger in a count. */
export function summarizeRows(rows: readonly WatchBoardRow[]): BoardSummary {
  const count = (kind: WatchActionKind): number => rows.filter((r) => r.action.kind === kind).length;
  return {
    watching: rows.length,
    us: rows.filter((r) => r.market === 'US').length,
    hk: rows.filter((r) => r.market === 'HK').length,
    sellPut: count('sell_put'),
    wait: count('wait'),
    avoid: count('avoid'),
    hold: count('hold'),
    needsData: count('needs_data'),
    earningsSoon: rows.filter(isResultsSoon).length,
    undervalued: rows.filter(isBelowIv).length,
  };
}
