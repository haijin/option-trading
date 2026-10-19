import { useEffect, useMemo, useState } from 'react';
import { api, links } from '../../api/endpoints';
import type { WatchBoardRow, WatchEntryView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { MarketChip } from '../../components/Chip';
import { Modal } from '../../components/Modal';
import { Panel } from '../../components/Panel';
import { Skeleton } from '../../components/Skeleton';
import { Switch } from '../../components/Switch';
import { Tabs } from '../../components/Tabs';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { stockKey } from '../../lib/symbols';
import { useRouter } from '../../state/router';
import { AddOnePanel } from './AddOnePanel';
import { AddPastePanel } from './AddPastePanel';
import { BoardTable } from './BoardTable';
import { BoardTiles } from './BoardTiles';
import { BoardToolbar } from './BoardToolbar';
import {
  type BoardFilter,
  DEFAULT_SORT,
  filterCounts,
  filterRows,
  type MarketFilter,
  nextSort,
  type SortKey,
  type SortState,
  sortFor,
  sortRows,
  summarizeRows,
} from './boardLib';
import { WatchEditor } from './WatchEditor';

const byMarketSymbol = (a: WatchEntryView, b: WatchEntryView) =>
  a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol);

function WhatWatchingMeans() {
  return (
    <details className="panel wl-help">
      <summary>What does &ldquo;watching&rdquo; mean?</summary>
      <ul className="stack wl-helplist">
        <li>
          <b>Ingest</b> fetches prices, fundamentals, US chains and earnings dates only for stocks you watch.
        </li>
        <li>
          <b>Scan</b> ranks only those stocks; the rest never appear in Today.
        </li>
        <li>
          <b>Research and skills</b> offer only those stocks, so no AI run is spent on a name you do not care about.
        </li>
        <li>
          <b>Not watching</b> keeps all history and settings; resume any time. Removing is always this soft: history is
          never deleted.
        </li>
        <li>
          <b>Open puts</b> block new ideas on that stock and are still tracked on Positions even if you stop watching
          it.
        </li>
        <li>
          <b>The recommendation</b> is today&rsquo;s scan verdict in plain words: Sell put (it passed every rule), Wait
          (a timing, volatility, earnings or sizing rule blocks it for now), Avoid (it fails the quality gate), Open put
          (you already have one) or Needs data.
        </li>
      </ul>
    </details>
  );
}

/** The watchlist as a table: what you watch, its KPIs, what stands out today and what the scan recommends. */
export function WatchlistPage() {
  const { route, navigate } = useRouter();
  const board = useResource((signal) => api.watchlistBoard(signal), []);
  const list = useResource((signal) => api.watchlist(signal), []);
  const mutation = useMutation();

  const [filter, setFilter] = useState<BoardFilter>('all');
  const [market, setMarket] = useState<MarketFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [adding, setAdding] = useState(false);
  const [addTab, setAddTab] = useState<'one' | 'paste'>('one');
  // Switch positions until the refetch lands, so a click feels instant. An entry stays here until the list and the
  // board both agree with it, because the board is rebuilt after every write and can trail the list by a few seconds.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const entries = useMemo(() => [...(list.data ?? [])].sort(byMarketSymbol), [list.data]);
  const boardRows = board.data?.rows;
  const boardKeys = useMemo(() => new Set((boardRows ?? []).map((r) => stockKey(r.market, r.symbol))), [boardRows]);

  useEffect(() => {
    if (!list.data || !boardRows) return;
    setOptimistic((current) => {
      const next = { ...current };
      let changed = false;
      for (const [key, value] of Object.entries(current)) {
        const entry = list.data?.find((e) => stockKey(e.market, e.symbol) === key);
        if (entry && entry.active === value && boardKeys.has(key) === value) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [list.data, boardRows, boardKeys]);

  const isActive = (entry: WatchEntryView) => optimistic[stockKey(entry.market, entry.symbol)] ?? entry.active;
  const activeKeys = useMemo(
    () =>
      new Set(
        entries
          .filter((e) => optimistic[stockKey(e.market, e.symbol)] ?? e.active)
          .map((e) => stockKey(e.market, e.symbol)),
      ),
    [entries, optimistic],
  );
  const visible = useMemo(
    () => (boardRows ?? []).filter((r) => (list.data ? activeKeys.has(stockKey(r.market, r.symbol)) : true)),
    [boardRows, list.data, activeKeys],
  );
  const paused = entries.filter((e) => !isActive(e));
  // Active names the board has not scored yet: just added or resumed, or an ingest has not reached them.
  const scoring = board.data ? entries.filter((e) => isActive(e) && !boardKeys.has(stockKey(e.market, e.symbol))) : [];

  const selected =
    route.page === 'watchlist' && route.market && route.symbol
      ? entries.find((e) => e.market === route.market && e.symbol === route.symbol)
      : undefined;

  const toggle = async (entry: Pick<WatchEntryView, 'market' | 'symbol' | 'hasOpenPut'>, next: boolean) => {
    const key = stockKey(entry.market, entry.symbol);
    setOptimistic((current) => ({ ...current, [key]: next }));
    const updated = await mutation.run(() => api.watchlistPatch(entry.market, entry.symbol, { active: next }), {
      success: next
        ? `${entry.symbol}: watching again. It is fetched and scanned from now on.`
        : `${entry.symbol}: not watching. No more fetching, scanning or research; history is kept.${entry.hasOpenPut ? ' Its open put is still tracked.' : ''}`,
    });
    if (!updated) setOptimistic((current) => ({ ...current, [key]: !next }));
  };

  const open = (market: WatchEntryView['market'], symbol: string) => navigate({ page: 'watchlist', market, symbol });
  const closeEditor = () => navigate({ page: 'watchlist' });
  const stopRow = (row: WatchBoardRow) =>
    toggle({ market: row.market, symbol: row.symbol, hasOpenPut: row.hasOpenPut }, false);

  // The chip counts describe what is left after market and search, so they add up with the table.
  const narrowed = useMemo(() => filterRows(visible, { filter: 'all', market, query }), [visible, market, query]);
  const counts = useMemo(() => filterCounts(narrowed), [narrowed]);
  const shown = useMemo(
    () => sortRows(filterRows(narrowed, { filter, market: 'all', query: '' }), sort),
    [narrowed, filter, sort],
  );
  const summary = useMemo(() => summarizeRows(visible), [visible]);
  const onSort = (key: SortKey) => setSort((current) => nextSort(current, key));
  const clearFilters = () => {
    setFilter('all');
    setMarket('all');
    setQuery('');
  };

  const firstLoad = (board.loading || list.loading) && !board.data;
  const nothingWatched = !!list.data && entries.every((e) => !isActive(e));
  const showAdd = adding || nothingWatched;

  return (
    <div className="page wl-board">
      <div className="row">
        <h2>Watchlist</h2>
        {board.data ? (
          <span className="muted wl-asof">
            Scored as of {board.data.asOf}
            {board.refreshing ? ' · updating' : ''}
          </span>
        ) : null}
        <div className="sp" />
        <a className="btn" href={links.watchlistCsv} download="watchlist.csv">
          Export CSV
        </a>
        <button
          type="button"
          className={`btn${showAdd ? '' : ' primary'}`}
          onClick={() => setAdding((a) => !a)}
          aria-expanded={showAdd}
        >
          {showAdd && !nothingWatched ? 'Close' : '+ Add stocks'}
        </button>
      </div>

      {board.error ? (
        <ErrorBanner error={board.error} onRetry={board.refresh} title="Could not score the watchlist." />
      ) : null}
      {list.error ? (
        <ErrorBanner error={list.error} onRetry={list.refresh} title="Could not load the watchlist." />
      ) : null}

      {showAdd ? (
        <Panel
          title="Add stocks"
          actions={
            <Tabs
              tabs={[
                { id: 'one', label: 'One symbol' },
                { id: 'paste', label: 'Paste a list' },
              ]}
              value={addTab}
              onChange={setAddTab}
              label="Add stocks"
            />
          }
        >
          {addTab === 'one' ? <AddOnePanel onAdded={() => undefined} /> : <AddPastePanel />}
        </Panel>
      ) : null}

      {firstLoad ? (
        <div aria-busy="true" className="stack">
          <span className="sr-only">Loading</span>
          <div className="wl-tiles">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={84} />
            ))}
          </div>
          <Skeleton height={300} />
        </div>
      ) : null}

      {board.data && visible.length > 0 ? (
        <>
          <BoardTiles summary={summary} rows={visible} />
          <BoardToolbar
            filter={filter}
            onFilter={setFilter}
            counts={counts}
            market={market}
            onMarket={setMarket}
            query={query}
            onQuery={setQuery}
            sort={sort.key}
            onSort={(key) => setSort(sortFor(key))}
          />
          <Panel flush className="wl-panel">
            {shown.length > 0 ? (
              <BoardTable
                rows={shown}
                sort={sort}
                onSort={onSort}
                onOpen={(row) => open(row.market, row.symbol)}
                onStop={stopRow}
              />
            ) : (
              <div className="list-empty">
                No stock matches.{' '}
                <button type="button" className="linklike" onClick={clearFilters}>
                  Show all {visible.length}
                </button>
              </div>
            )}
          </Panel>
          {!board.data.scored ? (
            <p className="note">
              The scan has not run, so no stock is scored yet. Set your equity in Settings, then it is scored.
            </p>
          ) : null}
          <p className="note">
            Prices are in each stock&rsquo;s own currency. Hover a column title for what it means. The recommendation is
            today&rsquo;s scan verdict, not advice; the app never places orders.
          </p>
        </>
      ) : null}

      {scoring.length > 0 ? (
        <Panel title={`Being scored · ${scoring.length}`}>
          <ul className="wl-plain">
            {scoring.map((entry) => (
              <li key={stockKey(entry.market, entry.symbol)}>
                <button type="button" className="linklike" onClick={() => open(entry.market, entry.symbol)}>
                  <b>{entry.symbol}</b> <small>{entry.name ?? ''}</small>
                </button>
                <MarketChip market={entry.market} />
                <span className="sp" />
                <small className="muted">{entry.status.detail ?? entry.status.label}</small>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {paused.length > 0 ? (
        <Panel title={`Not watching · ${paused.length}`} actions={<small className="muted">skipped everywhere</small>}>
          <ul className="wl-plain">
            {paused.map((entry) => (
              <li key={stockKey(entry.market, entry.symbol)} className="dim">
                <button type="button" className="linklike" onClick={() => open(entry.market, entry.symbol)}>
                  <b>{entry.symbol}</b> <small>{entry.name ?? ''}</small>
                </button>
                <MarketChip market={entry.market} />
                <span className="sp" />
                {entry.hasOpenPut ? <small className="muted">open put still tracked</small> : null}
                <Switch checked={false} onChange={(next) => toggle(entry, next)} label={`Watching ${entry.symbol}`} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <WhatWatchingMeans />

      {selected ? (
        <Modal title={`${selected.symbol}${selected.name ? ` · ${selected.name}` : ''}`} onClose={closeEditor} wide>
          <WatchEditor
            key={`${stockKey(selected.market, selected.symbol)}:${JSON.stringify([
              selected.active,
              selected.boardLot,
              selected.solvencyModel,
              selected.reportingFrequency,
              selected.conviction,
              selected.maxCollateralPct,
              selected.notes,
            ])}`}
            entry={{ ...selected, active: isActive(selected) }}
            onClose={closeEditor}
            onToggle={(next) => toggle(selected, next)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
