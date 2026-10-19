import { isApiError } from '../../api/client';
import type { LeaderCandidateView, LeadersView } from '../../api/types';
import { Chip } from '../../components/Chip';
import type { Resource } from '../../hooks/useResource';
import { pct } from '../../lib/format';
import { toHash } from '../../lib/route';
import { Empty, HomePanel, PanelState, type PanelSummary, Sym } from './HomePanel';

function LeaderRow({ c }: { c: LeaderCandidateView }) {
  const support = c.levels.find((l) => l.inPlay);
  const setup = c.state === 'setup';
  return (
    <a className="hm-row ldr" href={toHash({ page: 'leaders' })}>
      <Sym symbol={c.symbol} name={c.name} market={c.market} />
      <span className="st">
        <Chip kind={setup ? 'ok' : 'warn'}>{setup ? 'Setup' : 'Watch'}</Chip>
      </span>
      <span className="ln">
        {c.base ? (
          <>
            <span>
              <b>{pct(c.base.depthRatio * 100, 0)}</b> off high
            </span>
            <span>
              <b>{c.base.lenDays}</b>-day base
            </span>
          </>
        ) : null}
        {support ? <span>at {support.label}</span> : null}
        {c.quality ? (
          <span>
            quality {c.quality.pass} of {c.quality.total}
          </span>
        ) : null}
        {c.ret3mPct !== null ? (
          <span>
            3m {c.ret3mPct >= 0 ? '+' : ''}
            {pct(c.ret3mPct, 0)}
          </span>
        ) : null}
        {c.stopPct !== null ? <span>stop {pct(c.stopPct)}</span> : null}
        {c.earningsInDays !== null && c.earningsInDays <= 14 ? <span>results in {c.earningsInDays} d</span> : null}
        {c.isNew ? <span className="new">new today</span> : null}
      </span>
    </a>
  );
}

export function leadersSummary(leaders: Resource<LeadersView>): PanelSummary {
  const f = leaders.data?.funnel;
  const watchOnly = leaders.data?.regime?.posture === 'watch_only';
  return {
    count: f ? `${f.setup} ${f.setup === 1 ? 'setup' : 'setups'}` : null,
    kind: watchOnly ? 'warn' : f && f.setup > 0 ? 'ok' : 'quiet',
    tile: f ? { value: String(f.setup), label: f.setup === 1 ? 'Setup' : 'Setups' } : null,
  };
}

/** Leaders at support: today's shortlist, Setups first (the list arrives ranked). */
export function LeadersPanel({ leaders, limit }: { leaders: Resource<LeadersView>; limit: number }) {
  const data = leaders.data;
  const notSetUp = !data && isApiError(leaders.error) && leaders.error.code === 'migration_needed';
  const rows = (data?.candidates ?? []).filter((c) => c.rank !== null).slice(0, limit);
  const f = data?.funnel;
  const summary = leadersSummary(leaders);
  return (
    <HomePanel
      id="leaders"
      title="Leaders at support"
      count={summary.count}
      countKind={summary.kind}
      page="leaders"
      foot={
        f ? (
          <>
            <span>{f.watch} watch</span>
            <span>{f.newToday} new today</span>
            <span>{f.dropped} dropped</span>
            <span className="right">{data?.regime?.postureText ?? ''}</span>
          </>
        ) : null
      }
    >
      {notSetUp ? (
        <Empty>Leaders is not set up on this server yet: the migrations have not run.</Empty>
      ) : (
        <PanelState resource={leaders} title="Could not load the leaders." />
      )}
      {rows.map((c) => (
        <LeaderRow key={c.id} c={c} />
      ))}
      {data && data.asOf === null ? <Empty>No leaders scan has run yet. Open Leaders and refresh.</Empty> : null}
      {data && data.asOf !== null && rows.length === 0 ? <Empty>No leader is at a support today.</Empty> : null}
    </HomePanel>
  );
}
