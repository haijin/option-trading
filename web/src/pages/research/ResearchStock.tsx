import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { DataStatusRow, ValueView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip, MarketChip } from '../../components/Chip';
import { KpiPanel } from '../../components/KpiPanel';
import { KvGrid } from '../../components/Panel';
import { ScreenTable } from '../../components/ScreenTable';
import { DetailSkeleton } from '../../components/Skeleton';
import { Stars } from '../../components/Stars';
import { Tabs } from '../../components/Tabs';
import { ValuationCard } from '../../components/ValuationCard';
import { useResource } from '../../hooks/useResource';
import { money, priceVsIvText } from '../../lib/format';
import { toHash } from '../../lib/route';
import { AssumptionsPanel } from './AssumptionsPanel';
import { RateSlider } from './RateSlider';
import { ReportsTab } from './ReportsTab';
import { isActiveRun } from './RunCard';
import { RunSkillsTab } from './RunSkillsTab';
import { StockBacktestPanel } from './StockBacktestPanel';

type ResearchTab = 'value' | 'kpi' | 'run' | 'reports';
const TABS: { id: ResearchTab; label: string }[] = [
  { id: 'value', label: 'Value' },
  { id: 'kpi', label: 'KPIs & quality screen' },
  { id: 'run', label: 'Run skills' },
  { id: 'reports', label: 'Reports' },
];

function Header({ row, view }: { row: DataStatusRow; view: ValueView | undefined }) {
  const intrinsic = view?.intrinsic ?? null;
  return (
    <>
      <div className="dh">
        <h2>{row.symbol}</h2>
        <span className="muted">{row.name ?? ''}</span>
        <MarketChip market={row.market} />
        {row.status.kind === 'open_put' ? <Chip kind="blue">open put</Chip> : null}
        {row.stale ? <Chip kind="fail">price stale</Chip> : null}
        <div className="sp" />
        <a className="btn sm" href={toHash({ page: 'puts', market: row.market, symbol: row.symbol })}>
          See on Today
        </a>
      </div>
      {view && intrinsic ? (
        <KvGrid
          items={[
            { label: 'Price', value: money(intrinsic.price, intrinsic.currency, 2) },
            {
              label: 'Intrinsic value (base)',
              value: intrinsic.base === null ? '-' : money(intrinsic.base, intrinsic.currency, 2),
            },
            {
              label: 'Price vs intrinsic',
              value:
                intrinsic.priceRatio === null ? (
                  '-'
                ) : (
                  <>
                    <span className={priceVsIvText(intrinsic.priceRatio).tone}>
                      {priceVsIvText(intrinsic.priceRatio).text}
                    </span>{' '}
                    <Stars value={intrinsic.stars} />
                  </>
                ),
            },
            { label: 'Quality screen', value: view.screen.verdict },
          ]}
        />
      ) : null}
    </>
  );
}

/** Right pane of Research: header numbers, then Value, KPIs, Run skills and Reports for one stock. */
export function ResearchStock({ row }: { row: DataStatusRow }) {
  const { market, symbol } = row;
  const [tab, setTab] = useState<ResearchTab>('value');
  const [rate, setRate] = useState<number | undefined>(undefined);

  const value = useResource((signal) => api.value(market, symbol, rate, signal), [market, symbol], {
    softDeps: [rate],
  });
  const catalog = useResource((signal) => api.skills(signal), [], { refetchOnWrite: false });
  const runs = useResource((signal) => api.researchRuns(market, symbol, signal), [market, symbol], {
    pollWhile: (list) => list.some(isActiveRun),
    pollMs: 1500,
  });

  const view = value.data;
  const hasNumbers = view?.hasFundamentals ?? false;

  return (
    <>
      <Header row={row} view={view} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Research sections" />

      {tab === 'value' || tab === 'kpi' ? (
        <>
          {value.loading ? <DetailSkeleton /> : null}
          {value.error && !view ? (
            <ErrorBanner error={value.error} onRetry={value.refresh} title="Could not load the numbers." />
          ) : null}
          {value.error && view ? (
            <ErrorBanner error={value.error} onRetry={value.refresh} title="Could not refresh the numbers." />
          ) : null}
          {view && !hasNumbers ? (
            <Callout
              kind="blue"
              action={
                <a className="btn sm" href={toHash({ page: 'data' })}>
                  Run ingest
                </a>
              }
            >
              <b>No numbers yet for {symbol}.</b> Prices, fundamentals and KPIs arrive with its first ingest. The
              analysis skills still work: they gather their own data.
            </Callout>
          ) : null}
        </>
      ) : null}

      {tab === 'value' && view?.intrinsic ? (
        <>
          <ValuationCard
            intrinsic={view.intrinsic}
            fairValue={view.fairValue}
            headerExtra={<RateSlider value={rate ?? view.intrinsic.requiredReturnPct} onCommit={setRate} />}
          />
          <AssumptionsPanel key={JSON.stringify(view.overrides)} view={view} market={market} symbol={symbol} />
          <StockBacktestPanel market={market} symbol={symbol} />
        </>
      ) : null}
      {tab === 'kpi' && view && hasNumbers ? (
        <>
          <ScreenTable screen={view.screen} />
          <KpiPanel value={view} />
        </>
      ) : null}

      {tab === 'run' ? (
        catalog.data ? (
          <RunSkillsTab
            market={market}
            symbol={symbol}
            catalog={catalog.data}
            runs={runs.data ?? []}
            hasNumbers={hasNumbers}
          />
        ) : catalog.error ? (
          <ErrorBanner error={catalog.error} onRetry={catalog.refresh} title="Could not load the skills." />
        ) : (
          <DetailSkeleton />
        )
      ) : null}
      {tab === 'reports' ? (
        catalog.data ? (
          <ReportsTab runs={runs.data ?? []} catalog={catalog.data} symbol={symbol} />
        ) : (
          <DetailSkeleton />
        )
      ) : null}
      {runs.error && (tab === 'run' || tab === 'reports') ? (
        <ErrorBanner error={runs.error} onRetry={runs.refresh} title="Could not load the runs." />
      ) : null}
    </>
  );
}
