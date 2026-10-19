import type { LeaderFunnelView, LeaderStage } from '../../api/types';
import { num } from '../../lib/format';

interface Stage {
  id: LeaderStage;
  count: number;
  label: string;
  sub?: string;
}

/** The four stages in funnel order, with their counts. */
export function funnelStages(f: LeaderFunnelView): Stage[] {
  return [
    {
      id: 'screened',
      count: f.screened.total,
      label: 'screened',
      sub: `US ${num(f.screened.US)} · HK ${num(f.screened.HK)}`,
    },
    { id: 'leaders', count: f.leaders, label: 'leaders' },
    { id: 'consolidating', count: f.consolidating, label: 'in a valid base' },
    { id: 'shortlist', count: f.shortlist, label: 'shortlist' },
  ];
}

/**
 * screened, leaders, consolidating, shortlist: tapping a stage lists the names that stopped there (so "why is X not on the
 * list" has an answer). Under it the day's counts.
 */
export function Funnel({
  funnel,
  stage,
  onStage,
  archive,
}: {
  funnel: LeaderFunnelView;
  stage: LeaderStage;
  onStage: (stage: LeaderStage) => void;
  archive: boolean;
}) {
  return (
    <section className="ld-card ld-panel" aria-label="Funnel">
      <h2 className="ld-h">{archive ? 'Funnel that day' : "Today's funnel"}</h2>
      <div className="ld-funnel">
        {funnelStages(funnel).map((s) => (
          <button
            key={s.id}
            type="button"
            className={`ld-stage${stage === s.id ? ' sel' : ''}${s.id === 'shortlist' ? ' last' : ''}`}
            aria-pressed={stage === s.id}
            aria-label={`${num(s.count)} ${s.label}${s.sub ? `, ${s.sub}` : ''}`}
            onClick={() => onStage(s.id)}
          >
            <span className="n num">{num(s.count)}</span>
            <span className="l">{s.label}</span>
            {s.sub ? <span className="l sub">{s.sub}</span> : null}
          </button>
        ))}
      </div>
      <div className="ld-counts">
        <span>
          <b>{funnel.shortlist}</b> shortlisted
        </span>
        <span>
          <b>{funnel.setup}</b> setup
        </span>
        <span>
          <b>{funnel.watch}</b> watch
        </span>
        <span>
          <b>{funnel.newToday}</b> new {archive ? 'that day' : 'today'}
        </span>
        <span>
          <b>{funnel.dropped}</b> dropped
        </span>
        <span>
          <b>US {funnel.shortlistByMarket.US}</b> · <b>HK {funnel.shortlistByMarket.HK}</b>
        </span>
      </div>
    </section>
  );
}
