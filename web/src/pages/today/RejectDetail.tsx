import type { RejectView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { Chip, MarketChip, ValueChip } from '../../components/Chip';
import { Tabs } from '../../components/Tabs';
import { toHash } from '../../lib/route';
import { ChartTab, DETAIL_TABS, type DetailTab, ReasonsTab, SkillsTab, ValueTab } from './DetailTabs';

/** A name that did not make the shortlist: the binding rule in red, and the same tabs (explain mode: every skill ran). */
export function RejectDetail({
  reject,
  tab,
  onTab,
}: {
  reject: RejectView;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}) {
  const stale = reject.status === 'dropped_stale';
  return (
    <>
      <div className="dh">
        <h2>{reject.symbol}</h2>
        <span className="muted">{reject.name ?? ''}</span>
        <MarketChip market={reject.market} />
        {reject.sector ? <Chip>{reject.sector}</Chip> : null}
        <Chip kind="fail">not recommended</Chip>
        <ValueChip value={reject.value} />
        <div className="sp" />
        <a className="btn sm" href={toHash({ page: 'research', market: reject.market, symbol: reject.symbol })}>
          Research &amp; run skills &rarr;
        </a>
      </div>

      <Callout kind="fail" role="alert">
        <b>Not recommended.</b> Binding rule <span className="mono">{reject.bindingRule}</span>: {reject.detail}
        {reject.staleLastBar ? ` (last bar ${reject.staleLastBar})` : ''}
      </Callout>

      {stale ? (
        <Callout
          kind="blue"
          action={
            <a className="btn sm" href={toHash({ page: 'data' })}>
              Run ingest
            </a>
          }
        >
          No fresh price data: the freshness gate dropped this name before scoring, so there is nothing to chart. Run an
          ingest, or scan with stale data allowed to see it tagged STALE.
        </Callout>
      ) : null}

      <Tabs tabs={DETAIL_TABS} value={tab} onChange={onTab} label="Reject sections" />
      {tab === 'reasons' ? <ReasonsTab narrative={null} reasons={reject.reasons} skills={reject.skills} /> : null}
      {tab === 'chart' && !stale ? <ChartTab market={reject.market} symbol={reject.symbol} /> : null}
      {tab === 'chart' && stale ? (
        <p className="muted">No data to chart: last bar {reject.staleLastBar ?? 'unknown'}.</p>
      ) : null}
      {tab === 'value' ? <ValueTab market={reject.market} symbol={reject.symbol} /> : null}
      {tab === 'skills' ? <SkillsTab skills={reject.skills} /> : null}
      {!stale ? (
        <p className="note">
          Explain mode: every skill ran even though the gate failed, so you can see what else would have counted.
        </p>
      ) : null}
    </>
  );
}
