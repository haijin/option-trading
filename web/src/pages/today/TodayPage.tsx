import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import type { LeadersCardView, ScanView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { DetailSkeleton, ListSkeleton } from '../../components/Skeleton';
import { useArrowKeys } from '../../hooks/useArrowKeys';
import { useResource } from '../../hooks/useResource';
import { MasterDetail } from '../../layout/MasterDetail';
import { toHash } from '../../lib/route';
import { stockKey } from '../../lib/symbols';
import { useOverview } from '../../state/overview';
import { useRouter } from '../../state/router';
import { LeadersTodayCard } from '../leaders/LeadersTodayCard';
import type { DetailTab } from './DetailTabs';
import { IdeaDetail } from './IdeaDetail';
import { RejectDetail } from './RejectDetail';
import { orderedSelectables, type Selectable, selectableKey, TodayList } from './TodayList';

export function isEquityNotSet(error: Error | null): boolean {
  return isApiError(error) && error.code === 'equity_not_set';
}

function EquityNotSet() {
  return (
    <div className="page">
      <Callout
        kind="fail"
        role="alert"
        action={
          <a className="btn sm primary" href={toHash({ page: 'settings' })}>
            Open Settings
          </a>
        }
      >
        <b>Equity is not set.</b> The scan refuses to run until you tell it how much capital to size against. Set it in
        Settings, then run the scan.
      </Callout>
    </div>
  );
}

function EmptyToday({
  scan,
  watching,
  leaders,
}: {
  scan: ScanView;
  watching: number | undefined;
  leaders: LeadersCardView | null | undefined;
}) {
  if (watching === 0) {
    return (
      <div className="page">
        <LeadersTodayCard card={leaders} />
        <Callout
          kind="blue"
          action={
            <a className="btn sm primary" href={toHash({ page: 'watchlist' })}>
              Open Watchlist
            </a>
          }
        >
          <b>You are not watching any stock yet.</b> Add the stocks you want scanned in the Watchlist; only watched
          stocks are fetched and scanned.
        </Callout>
      </div>
    );
  }
  return (
    <div className="page">
      <LeadersTodayCard card={leaders} />
      {scan.waitingForData.length > 0 ? (
        <Callout
          kind="blue"
          action={
            <a className="btn sm primary" href={toHash({ page: 'data' })}>
              Run ingest
            </a>
          }
        >
          <b>Waiting for data:</b> {scan.waitingForData.map((w) => w.symbol).join(', ')}{' '}
          {scan.waitingForData.length === 1 ? 'has' : 'have'} no prices yet. Run an ingest on the Data page, then scan
          again.
        </Callout>
      ) : (
        <Callout kind="blue">
          Nothing to show: none of the stocks you watch produced a result. Run an ingest, then scan again.
        </Callout>
      )}
    </div>
  );
}

export function TodayPage() {
  const { route, navigate, replace } = useRouter();
  const overview = useOverview();
  const scan = useResource((signal) => api.scan(signal), []);
  const [tab, setTab] = useState<DetailTab>('reasons');
  const detailRef = useRef<HTMLDivElement>(null);

  const data = scan.data;
  const items = useMemo(() => (data ? orderedSelectables(data) : []), [data]);
  const wantedKey = route.page === 'puts' && route.market && route.symbol ? stockKey(route.market, route.symbol) : null;
  const selected = items.find((item) => selectableKey(item) === wantedKey) ?? items[0] ?? null;
  const selectedKey = selected ? selectableKey(selected) : null;
  const selectedStock = selected ? (selected.kind === 'idea' ? selected.idea : selected.reject) : null;
  const back = () => navigate({ page: 'puts' });

  const select = (item: Selectable, quiet = false) => {
    const target = item.kind === 'idea' ? item.idea : item.reject;
    (quiet ? replace : navigate)({ page: 'puts', market: target.market, symbol: target.symbol });
  };

  const move = (step: number) => {
    if (items.length === 0) return;
    const index = items.findIndex((item) => selectableKey(item) === selectedKey);
    const next = items[Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + step))];
    if (next) select(next, true);
  };
  useArrowKeys(
    () => move(-1),
    () => move(1),
    items.length > 0,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll back to the top whenever the selection changes
  useEffect(() => {
    detailRef.current?.scrollTo?.(0, 0);
  }, [selectedKey]);

  if (isEquityNotSet(scan.error)) return <EquityNotSet />;
  if (scan.loading) {
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
  if (scan.error && !data) {
    return (
      <div className="page">
        <ErrorBanner error={scan.error} onRetry={scan.refresh} title="The scan could not run." />
      </div>
    );
  }
  if (!data) return null;
  if (items.length === 0 && data.openNames.length === 0) {
    return <EmptyToday scan={data} watching={overview.data?.watchlist.watching} leaders={overview.data?.leaders} />;
  }

  return (
    <MasterDetail
      showDetail={wantedKey !== null && selected !== null}
      onBack={back}
      title={selectedStock?.symbol}
      subtitle={selectedStock ? `${selectedStock.name ?? ''} ${selectedStock.market}`.trim() : undefined}
      detailRef={detailRef}
      list={
        <TodayList
          scan={data}
          selectedKey={selectedKey}
          onSelect={select}
          refreshing={scan.refreshing}
          leaders={overview.data?.leaders}
        />
      }
      detail={
        <>
          {scan.error ? (
            <ErrorBanner error={scan.error} onRetry={scan.refresh} title="Could not refresh the scan." />
          ) : null}
          {selected?.kind === 'idea' ? (
            <IdeaDetail key={selectedKey} idea={selected.idea} asOf={data.asOf} tab={tab} onTab={setTab} />
          ) : null}
          {selected?.kind === 'reject' ? (
            <RejectDetail key={selectedKey} reject={selected.reject} tab={tab} onTab={setTab} />
          ) : null}
          {!selected ? (
            <Callout kind="blue">
              No idea or rejection to show yet. Names with an open put are listed on the left and are not scanned for
              new ideas.
            </Callout>
          ) : null}
        </>
      }
    />
  );
}
