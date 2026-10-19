import { useMemo } from 'react';
import { api } from '../../api/endpoints';
import type { DataStatusRow } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { PriceVsIvChip } from '../../components/Chip';
import { DetailSkeleton, ListSkeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { MasterDetail } from '../../layout/MasterDetail';
import { toHash } from '../../lib/route';
import { stockKey } from '../../lib/symbols';
import { useRouter } from '../../state/router';
import { ResearchStock } from './ResearchStock';

function Group({
  title,
  rows,
  selectedKey,
  onSelect,
}: {
  title: string;
  rows: DataStatusRow[];
  selectedKey: string | null;
  onSelect: (row: DataStatusRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="gh">
        <span>
          {title} &middot; {rows.length}
        </span>
        <span>price vs intrinsic value</span>
      </div>
      {rows.map((row) => {
        const key = stockKey(row.market, row.symbol);
        return (
          <button
            type="button"
            key={key}
            className={`lrow${key === selectedKey ? ' sel' : ''}`}
            aria-current={key === selectedKey ? 'true' : undefined}
            onClick={() => onSelect(row)}
          >
            <span className="s">
              {row.symbol}
              <small>{row.name ?? ''}</small>
            </span>
            <span />
            <span className="num">
              <PriceVsIvChip badge={row.priceVsIv} />
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function ResearchPage() {
  const { route, navigate } = useRouter();
  const status = useResource((signal) => api.dataStatus(signal), []);

  const rows = useMemo(
    () =>
      (status.data?.names ?? [])
        .filter((row) => row.status.kind !== 'paused')
        .sort((a, b) => a.market.localeCompare(b.market) * -1 || a.symbol.localeCompare(b.symbol)),
    [status.data],
  );
  const wantedKey =
    route.page === 'research' && route.market && route.symbol ? stockKey(route.market, route.symbol) : null;
  // A name investigated from the Leaders page is not on the watchlist, so it has no data-status row: show it anyway, bare.
  const standIn: DataStatusRow | null =
    wantedKey !== null &&
    route.market &&
    route.symbol &&
    !rows.some((row) => stockKey(row.market, row.symbol) === wantedKey)
      ? {
          symbol: route.symbol,
          market: route.market,
          name: null,
          lastBar: null,
          lastClose: null,
          chain: null,
          nextEarnings: null,
          fundamentals: { annual: 0, quarterly: 0, lastPeriodEnd: null },
          stale: false,
          priceVsIv: null,
          status: { kind: 'unscored', label: 'not on your watchlist', detail: null },
        }
      : null;
  const selected = rows.find((row) => stockKey(row.market, row.symbol) === wantedKey) ?? standIn ?? rows[0] ?? null;
  const selectedKey = selected ? stockKey(selected.market, selected.symbol) : null;
  const select = (row: DataStatusRow) => navigate({ page: 'research', market: row.market, symbol: row.symbol });
  const back = () => navigate({ page: 'research' });

  if (status.loading) {
    return (
      <MasterDetail
        busy
        showDetail={wantedKey !== null}
        onBack={back}
        title={route.symbol}
        list={
          <div className="list">
            <ListSkeleton />
          </div>
        }
        detail={<DetailSkeleton />}
      />
    );
  }
  if (status.error && !status.data) {
    return (
      <div className="page">
        <ErrorBanner error={status.error} onRetry={status.refresh} title="Could not load the watched stocks." />
      </div>
    );
  }
  if (rows.length === 0 && !standIn) {
    return (
      <div className="page">
        <Callout
          kind="blue"
          action={
            <a className="btn sm primary" href={toHash({ page: 'watchlist' })}>
              Open Watchlist
            </a>
          }
        >
          Nothing to research: you are not watching any stock. Add or resume stocks in the watchlist.
        </Callout>
      </div>
    );
  }

  return (
    <MasterDetail
      showDetail={wantedKey !== null && selected !== null}
      onBack={back}
      title={selected?.symbol}
      subtitle={selected ? `${selected.name ?? ''} ${selected.market}`.trim() : undefined}
      list={
        <section className="list" aria-label="Watched stocks">
          <Group title="US" rows={rows.filter((r) => r.market === 'US')} selectedKey={selectedKey} onSelect={select} />
          <Group title="HK" rows={rows.filter((r) => r.market === 'HK')} selectedKey={selectedKey} onSelect={select} />
        </section>
      }
      detail={selected ? <ResearchStock key={selectedKey} row={selected} /> : null}
    />
  );
}
