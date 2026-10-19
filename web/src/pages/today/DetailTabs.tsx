import { api } from '../../api/endpoints';
import type { ExplainView, Market, ReasonView, SkillRowView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip } from '../../components/Chip';
import { Panel } from '../../components/Panel';
import { PriceChart } from '../../components/PriceChart';
import { ReasonsTable, SkillsTable, TiersRow } from '../../components/ReasonsTable';
import { ScreenTable } from '../../components/ScreenTable';
import { DetailSkeleton } from '../../components/Skeleton';
import { ValuationCard } from '../../components/ValuationCard';
import { useResource } from '../../hooks/useResource';
import { shortDate } from '../../lib/format';
import { toHash } from '../../lib/route';
import { splitNarrativeLine } from '../../lib/ticket';

export type DetailTab = 'reasons' | 'chart' | 'value' | 'skills';

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'reasons', label: 'Reasons' },
  { id: 'chart', label: 'Chart & evidence' },
  { id: 'value', label: 'Value & KPIs' },
  { id: 'skills', label: 'Scanner skills' },
];

export function ReasonsTab({
  narrative,
  reasons,
  skills,
}: {
  narrative: { headline: string; lines: string[] } | null;
  reasons: readonly ReasonView[];
  skills: readonly SkillRowView[];
}) {
  return (
    <Panel>
      {narrative ? (
        <>
          <p className="headline">{narrative.headline}</p>
          <ul className="nar">
            {narrative.lines.map((line) => {
              const { label, text } = splitNarrativeLine(line);
              return (
                <li key={line}>
                  {label ? <b>{label}</b> : null} {text}
                </li>
              );
            })}
          </ul>
          <div className="hr" />
        </>
      ) : null}
      <TiersRow skills={skills} />
      {skills.length > 0 ? <div className="hr" /> : null}
      <ReasonsTable reasons={reasons} />
    </Panel>
  );
}

export function SkillsTab({ skills }: { skills: readonly SkillRowView[] }) {
  return (
    <Panel flush>
      <SkillsTable skills={skills} />
    </Panel>
  );
}

function EventsTable({ explain }: { explain: ExplainView }) {
  const rows: { date: string; label: string; note: string; check: boolean }[] = explain.events.map((event) => ({
    date: event.date,
    label: event.type.replace(/_/g, ' '),
    note: `${event.confirmed ? 'confirmed' : 'estimated'} (${event.source})`,
    check: !event.confirmed,
  }));
  if (!explain.events.some((event) => event.type === 'earnings')) {
    rows.unshift({
      date: '-',
      label: 'results date unknown',
      note: 'add one with "Add date" on the idea',
      check: true,
    });
  }
  if (explain.contract) {
    rows.push({
      date: explain.contract.expiry,
      label: 'contract expiry',
      note: `${explain.contract.dte} DTE`,
      check: false,
    });
  }
  return (
    <table className="tbl">
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.date}-${row.label}`}>
            <td className="mono" style={{ width: 110 }}>
              {row.date}
            </td>
            <td>{row.label}</td>
            <td className="muted">{row.note}</td>
            <td>{row.check ? <Chip kind="warn">check</Chip> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Price chart plus the evidence behind the verdict: events and every scanner skill (explain mode). */
export function ChartTab({ market, symbol }: { market: Market; symbol: string }) {
  const chart = useResource((signal) => api.chart(market, symbol, 180, signal), [market, symbol]);
  const explain = useResource((signal) => api.explain(market, symbol, signal), [market, symbol]);

  return (
    <div className="dd">
      {chart.error && !chart.data ? (
        <ErrorBanner error={chart.error} onRetry={chart.refresh} title="Could not load the chart." />
      ) : null}
      {chart.loading ? <DetailSkeleton /> : chart.data ? <PriceChart chart={chart.data} /> : null}
      {chart.data ? (
        <p className="note" style={{ marginTop: -6 }}>
          last 180 sessions to {chart.data.asOf} &middot; <span style={{ color: '#d9822b' }}>SMA50</span> &middot;{' '}
          <span style={{ color: '#8b5cf6' }}>SMA200</span>
          {chart.data.supportSource ? ` · support from ${chart.data.supportSource}` : ''}
        </p>
      ) : null}
      {explain.error && !explain.data ? (
        <ErrorBanner error={explain.error} onRetry={explain.refresh} title="Could not load the evidence." />
      ) : null}
      {explain.data ? (
        <>
          {explain.data.freshness.stale.length > 0 ? (
            <Callout>
              <b>Stale data:</b>{' '}
              {explain.data.freshness.stale
                .map((s) => `${s.source} (last ${s.last ?? 'never'}): ${s.detail}`)
                .join('; ')}
            </Callout>
          ) : null}
          <div>
            <h4 style={{ marginBottom: 6 }}>Event calendar</h4>
            <EventsTable explain={explain.data} />
          </div>
          <div>
            <h4 style={{ marginBottom: 6 }}>Scanner skills S0 to S7 (explain)</h4>
            <SkillsTable skills={explain.data.skills} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Intrinsic value and the quality screen; the full KPI table lives on Research. */
export function ValueTab({ market, symbol }: { market: Market; symbol: string }) {
  const value = useResource((signal) => api.value(market, symbol, undefined, signal), [market, symbol]);
  if (value.loading) return <DetailSkeleton />;
  if (value.error && !value.data)
    return <ErrorBanner error={value.error} onRetry={value.refresh} title="Could not load the valuation." />;
  const view = value.data;
  if (!view) return null;
  return (
    <div className="dd">
      {!view.hasFundamentals ? (
        <Callout kind="blue">
          No fundamentals are stored for {symbol} yet, so there is no intrinsic value or quality screen. Run an ingest
          from the Data page.
        </Callout>
      ) : null}
      {view.intrinsic ? <ValuationCard intrinsic={view.intrinsic} fairValue={view.fairValue} /> : null}
      {view.hasFundamentals ? <ScreenTable screen={view.screen} /> : null}
      <Callout
        kind="blue"
        action={
          <a className="btn sm" href={toHash({ page: 'research', market, symbol })}>
            Open Research &rarr;
          </a>
        }
      >
        The full KPI table, quarterly figures and the analysis skills are on the Research page.
        {view.fundamentals.lastPeriodEnd ? ` Latest statements: ${shortDate(view.fundamentals.lastPeriodEnd)}.` : ''}
      </Callout>
    </div>
  );
}
