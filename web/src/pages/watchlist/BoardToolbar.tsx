import { type BoardFilter, FILTERS, type MarketFilter, SORTS, type SortKey } from './boardLib';

const MARKETS: { id: MarketFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'US', label: 'US' },
  { id: 'HK', label: 'HK' },
];

/** Filter chips with counts, market, search and (on a phone, where the header row is gone) a sort menu. */
export function BoardToolbar({
  filter,
  onFilter,
  counts,
  market,
  onMarket,
  query,
  onQuery,
  sort,
  onSort,
}: {
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  /** Rows each chip would show, over the market and search already applied. */
  counts: Record<BoardFilter, number>;
  market: MarketFilter;
  onMarket: (m: MarketFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  sort: SortKey;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="wl-toolbar">
      <fieldset className="wl-chips-row" aria-label="Show">
        {FILTERS.map((f) => {
          // a chip that would show nothing stays out of the way, unless it is the one in use
          if (f.id !== 'all' && counts[f.id] === 0 && filter !== f.id) return null;
          return (
            <button
              key={f.id}
              type="button"
              className={`wl-fchip${filter === f.id ? ' on' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => onFilter(f.id)}
            >
              {f.label} <span className="wl-count">{counts[f.id]}</span>
            </button>
          );
        })}
      </fieldset>
      <div className="wl-tools">
        <fieldset className="wl-seg" aria-label="Market">
          {MARKETS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={market === m.id ? 'on' : ''}
              aria-pressed={market === m.id}
              onClick={() => onMarket(m.id)}
            >
              {m.label}
            </button>
          ))}
        </fieldset>
        <input
          className="wl-search"
          type="search"
          inputMode="search"
          placeholder="Find a stock"
          aria-label="Find a stock"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <select
          className="wl-sortsel"
          aria-label="Sort"
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              Sort: {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
