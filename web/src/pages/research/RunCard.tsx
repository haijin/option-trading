import type { ResearchRunView, RunStatus } from '../../api/types';
import { Chip, type ChipKind } from '../../components/Chip';
import { useNow } from '../../hooks/useNow';
import { elapsed, num } from '../../lib/format';
import { ReportView } from './ReportView';

const STATUS_KIND: Record<RunStatus, ChipKind> = {
  queued: '',
  running: 'blue',
  done: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};

export const isActiveRun = (run: ResearchRunView): boolean => run.status === 'queued' || run.status === 'running';

/** Progress of one run: step checklist, the output tail, elapsed time and cost; the report once it is done. */
export function RunCard({
  run,
  skillName,
  onCancel,
  cancelling,
}: {
  run: ResearchRunView;
  skillName: string;
  onCancel: (run: ResearchRunView) => void;
  cancelling: boolean;
}) {
  const active = isActiveRun(run);
  const now = useNow(run.status === 'running');
  const started = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.createdAt);
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const spent = run.status === 'queued' ? null : Math.max(0, ended - started);

  return (
    <div className="stack">
      <div className="row">
        <b>{skillName}</b>
        <Chip kind={STATUS_KIND[run.status]}>{run.status === 'queued' ? 'waiting in the queue' : run.status}</Chip>
        {spent !== null ? <small>elapsed {elapsed(spent)}</small> : null}
        {run.costUsd !== null ? <small>cost US${num(run.costUsd, 2)}</small> : null}
        {run.model ? <Chip>{run.model}</Chip> : null}
        <div className="sp" />
        {active ? (
          <button type="button" className="btn sm danger" onClick={() => onCancel(run)} disabled={cancelling}>
            Cancel
          </button>
        ) : null}
      </div>

      {active || run.status === 'failed' || run.status === 'cancelled' ? (
        <ol className="steps2" aria-label="Steps">
          {run.steps.map((step, index) => {
            const done = run.status === 'done' || index < run.stepIndex;
            const current = run.status === 'running' && index === run.stepIndex;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed and may repeat a title
              <li key={`${index}-${step}`} className={`s${done ? ' done' : current ? ' cur' : ''}`}>
                {done ? '✓' : current ? '▸' : '○'} {step}
              </li>
            );
          })}
        </ol>
      ) : null}

      {run.status === 'running' && run.progress.length > 0 ? (
        <div className="log" role="log" aria-label="Latest output">
          {run.progress.join('\n')}
        </div>
      ) : null}
      {run.status === 'failed' && run.error ? <div className="callout fail">{run.error}</div> : null}
      {run.status === 'cancelled' ? <small>Cancelled before it finished.</small> : null}
      {run.status === 'done' && run.hasReport ? <ReportView runId={run.id} /> : null}
      {run.status === 'done' && !run.hasReport ? <small>The run finished without a report.</small> : null}
    </div>
  );
}
