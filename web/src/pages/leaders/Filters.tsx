import { type MarketFilter, SORTS, type SortKey, type StateFilter } from './leadersLib';

const MARKETS: { id: MarketFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'US', label: 'US' },
  { id: 'HK', label: 'HK' },
];
const STATES: { id: StateFilter; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'watch', label: 'Watch' },
  { id: 'all', label: 'All' },
];

function Seg<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="ld-seg" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={value === o.id ? 'on' : ''}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Market, state and sort. All three work on the names already returned, so they answer at once. The state filter only applies to the shortlist. */
export function Filters({
  market,
  onMarket,
  state,
  onState,
  sort,
  onSort,
  showState,
}: {
  market: MarketFilter;
  onMarket: (m: MarketFilter) => void;
  state: StateFilter;
  onState: (s: StateFilter) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  showState: boolean;
}) {
  return (
    <div className="ld-filters">
      <Seg label="Market" options={MARKETS} value={market} onChange={onMarket} />
      {showState ? <Seg label="State" options={STATES} value={state} onChange={onState} /> : null}
      <select className="ld-sort" aria-label="Sort" value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
        {SORTS.map((s) => (
          <option key={s.id} value={s.id}>
            Sort: {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
