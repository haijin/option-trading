import type { MouseEvent } from 'react';
import type { WatchActionKind, WatchBoardRow, WatchHighlight } from '../../api/types';
import { Chip, type ChipKind, MarketChip } from '../../components/Chip';
import { Sparkline } from '../../components/Sparkline';
import { Stars } from '../../components/Stars';
import { Switch } from '../../components/Switch';
import { n1, n2, num, pct, shortDate, signedPct, strikeText } from '../../lib/format';
import type { SortKey, SortState } from './boardLib';

interface Column {
  label: string;
  /** Sorts by this key when clicked; a column without one is not sortable. */
  sort?: SortKey;
  numeric?: boolean;
  /** Plain-English meaning, shown as the header tooltip. */
  help: string;
}

const COLUMNS: Column[] = [
  { label: 'Stock', sort: 'stock', help: 'Symbol, market and your conviction. Click a stock to edit its settings.' },
  { label: 'Recommendation', sort: 'action', help: 'Today’s scan verdict in plain words, and the put it proposes.' },
  { label: 'Highlight', help: 'What stands out about the stock today.' },
  {
    label: 'Price · day',
    sort: 'change',
    numeric: true,
    help: 'Last close in the stock’s own currency, the change since the previous close, and the last 60 closes. Click to sort by the day change.',
  },
  { label: 'Trend', help: 'Direction of the price trend, and how far the price is above its support level.' },
  {
    label: 'IV rank',
    sort: 'ivRank',
    numeric: true,
    help: 'Where today’s implied volatility sits in its own one-year range, 0 to 100. High means richer put premium.',
  },
  {
    label: 'ROE',
    sort: 'roe',
    numeric: true,
    help: 'Return on equity, five-year average. Above 15% is good.',
  },
  {
    label: 'FCF yield',
    sort: 'fcf',
    numeric: true,
    help: 'Free cash flow per share over price. The scan wants at least 4%. Not shown for banks and insurers.',
  },
  {
    label: 'P/E',
    sort: 'pe',
    numeric: true,
    help: 'Trailing price over earnings. Blank when the company lost money.',
  },
  {
    label: 'Price vs IV',
    sort: 'value',
    help: 'Price against intrinsic value (the base case on the Research page). Below means a margin of safety.',
  },
  { label: 'Results', sort: 'earnings', help: 'Next results date. A put is blocked if its expiry would span it.' },
  { label: 'Watch', help: 'Turn off to stop fetching, scanning and researching it. History is kept.' },
];

const ACTION_KIND: Record<WatchActionKind, ChipKind> = {
  sell_put: 'ok',
  wait: 'warn',
  avoid: 'fail',
  hold: 'blue',
  needs_data: '',
};

const TONE_KIND: Record<WatchHighlight['tone'], ChipKind> = { good: 'ok', warn: 'warn', info: 'blue' };

const TREND: Record<NonNullable<WatchBoardRow['trend']>, { label: string; kind: ChipKind }> = {
  up: { label: 'Up', kind: 'ok' },
  side: { label: 'Sideways', kind: '' },
  down: { label: 'Down', kind: 'fail' },
};

function Header({ sort, onSort }: { sort: SortState; onSort: (key: SortKey) => void }) {
  return (
    <thead>
      <tr>
        {COLUMNS.map((column, index) => {
          const active = column.sort !== undefined && sort.key === column.sort;
          const cls = [column.numeric ? 'num' : '', index === 0 ? 'wl-sticky' : ''].filter(Boolean).join(' ');
          return (
            <th
              key={column.label}
              className={cls || undefined}
              title={column.help}
              aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
            >
              {column.sort ? (
                <button
                  type="button"
                  className="wl-th"
                  onClick={() => column.sort && onSort(column.sort)}
                  aria-label={`Sort by ${column.label}`}
                >
                  {column.label}
                  <span className="wl-arrow" aria-hidden="true">
                    {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                  </span>
                </button>
              ) : (
                column.label
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

const dash = <span className="faint">-</span>;

function PriceCell({ row }: { row: WatchBoardRow }) {
  if (row.price === null) return <span className="faint">no price yet</span>;
  const up = row.changePct === null || row.changePct >= 0;
  return (
    <div className="wl-price">
      <div>
        <b>{n2(row.price)}</b>
        <div className={row.changePct === null ? 'faint' : up ? 'pos' : 'neg'}>
          {row.changePct === null ? '-' : signedPct(row.changePct, 2)}
        </div>
      </div>
      {row.closes.length >= 2 ? (
        <span className={(row.closes[0] ?? row.price) <= row.price ? 'pos' : 'neg'}>
          <Sparkline values={row.closes} label={`${row.symbol} last ${row.closes.length} closes`} />
        </span>
      ) : null}
    </div>
  );
}

function TrendCell({ row }: { row: WatchBoardRow }) {
  if (row.trend === null && row.supportDistPct === null) return dash;
  const trend = row.trend ? TREND[row.trend] : null;
  const dist = row.supportDistPct;
  return (
    <div className="wl-stack">
      {trend ? <Chip kind={trend.kind}>{trend.label}</Chip> : null}
      {dist !== null ? (
        <small className={dist < 0 ? 'neg' : 'muted'}>
          {num(Math.abs(dist), 1)}% {dist < 0 ? 'below' : 'above'} support
        </small>
      ) : null}
    </div>
  );
}

function IvRankCell({ row }: { row: WatchBoardRow }) {
  if (row.ivRank === null) return dash;
  const rich = row.ivRank >= 60;
  const thin = row.ivRank <= 20;
  return (
    <span
      className={rich ? 'pos' : thin ? 'faint' : undefined}
      title={rich ? 'rich premium' : thin ? 'thin premium' : undefined}
    >
      {num(row.ivRank, 0)}
      <span className="sbar" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, row.ivRank))}%` }} />
      </span>
    </span>
  );
}

function ValueCell({ row }: { row: WatchBoardRow }) {
  if (!row.value) return dash;
  const diff = Math.round(Math.abs(row.value.priceRatio - 1) * 100);
  const text = diff === 0 ? 'at IV' : `${diff}% ${row.value.priceRatio > 1 ? 'above' : 'below'} IV`;
  const tone = diff === 0 ? undefined : row.value.priceRatio > 1 ? 'neg' : 'pos';
  return (
    <div className="wl-stack" title={`intrinsic value ${n2(row.value.base)} (base case)`}>
      <b className={tone}>{text}</b>
      <small className="muted">IV {n2(row.value.base)}</small>
    </div>
  );
}

function EarningsCell({ row }: { row: WatchBoardRow }) {
  const e = row.nextEarnings;
  if (!e) return <span className="faint">unknown</span>;
  const days = row.earningsInDays;
  const soon = days !== null && days <= 14;
  return (
    <div className="wl-stack">
      <span className={soon ? 'neg' : undefined}>{shortDate(e.date)}</span>
      <small className={soon ? 'neg' : 'muted'}>
        {days === null ? 'passed' : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}
        {e.confirmed ? '' : ' (est.)'}
      </small>
    </div>
  );
}

function RecommendationCell({ row }: { row: WatchBoardRow }) {
  const a = row.action;
  const put = row.put;
  return (
    <div className="wl-rec">
      <Chip kind={ACTION_KIND[a.kind]}>{a.label}</Chip>
      <div className="wl-why">{a.reason}</div>
      {put ? (
        <div className="wl-put">
          <b>
            {strikeText(put.strike)}P {shortDate(put.expiry)}
          </b>{' '}
          <span className="muted">
            {put.dte}d &middot; delta {n2(put.delta)} &middot; premium {n2(put.premium)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Row({ row, onOpen, onStop }: { row: WatchBoardRow; onOpen: () => void; onStop: () => void }) {
  // A click anywhere on the row opens the editor, except on a control inside it (the switch, the stock button).
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input, select')) return;
    onOpen();
  };
  return (
    <tr className="wl-tr" onClick={onRowClick} data-action={row.action.kind}>
      <td className="full wl-sticky wl-stock">
        <button type="button" className="linklike wl-open" onClick={onOpen} title={`Edit ${row.symbol}`}>
          <b>{row.symbol}</b>
          <small>{row.name ?? ''}</small>
        </button>
        <div className="wl-sub">
          <MarketChip market={row.market} />
          {row.conviction ? <Stars value={row.conviction} /> : null}
        </div>
      </td>
      <td className="full wl-recommend">
        <RecommendationCell row={row} />
      </td>
      <td className="full wl-hl">
        {row.highlights.length === 0 ? (
          <span className="faint">Nothing stands out</span>
        ) : (
          <div className="wl-chips">
            {row.highlights.map((h) => (
              <Chip key={h.text} kind={TONE_KIND[h.tone]}>
                {h.text}
              </Chip>
            ))}
          </div>
        )}
      </td>
      <td data-label="Price" className="num">
        <PriceCell row={row} />
      </td>
      <td data-label="Trend">
        <TrendCell row={row} />
      </td>
      <td data-label="IV rank" className="num">
        <IvRankCell row={row} />
      </td>
      <td data-label="ROE" className="num">
        {row.roePct === null ? (
          dash
        ) : (
          <span className={row.roePct >= 15 ? 'pos' : row.roePct < 8 ? 'neg' : undefined}>{pct(row.roePct, 1)}</span>
        )}
      </td>
      <td data-label="FCF yield" className="num">
        {row.fcfYieldPct === null ? (
          dash
        ) : (
          <span className={row.fcfYieldPct < 0 ? 'neg' : row.fcfYieldPct >= 4 ? 'pos' : undefined}>
            {pct(row.fcfYieldPct, 1)}
          </span>
        )}
      </td>
      <td data-label="P/E" className="num">
        {row.pe === null ? dash : `${n1(row.pe)}x`}
      </td>
      <td data-label="Price vs IV">
        <ValueCell row={row} />
      </td>
      <td data-label="Results">
        <EarningsCell row={row} />
      </td>
      <td data-label="Watching" className="wl-watch">
        <Switch checked onChange={onStop} label={`Watching ${row.symbol}`} />
      </td>
    </tr>
  );
}

/**
 * The board: one row per watched stock, decision first (stock, recommendation, highlight) and the numbers behind it after.
 * A wide table on a desktop (the first column stays put while it scrolls), stacked cards in the same order on a phone.
 */
export function BoardTable({
  rows,
  sort,
  onSort,
  onOpen,
  onStop,
}: {
  rows: readonly WatchBoardRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpen: (row: WatchBoardRow) => void;
  onStop: (row: WatchBoardRow) => void;
}) {
  return (
    <table className="tbl cards wl-table" aria-label="Watched stocks">
      <Header sort={sort} onSort={onSort} />
      <tbody>
        {rows.map((row) => (
          <Row key={`${row.market}:${row.symbol}`} row={row} onOpen={() => onOpen(row)} onStop={() => onStop(row)} />
        ))}
      </tbody>
    </table>
  );
}
