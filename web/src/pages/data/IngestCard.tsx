import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import type { DataStatusView, IngestJobView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip, type ChipKind } from '../../components/Chip';
import { Panel } from '../../components/Panel';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { dateTime } from '../../lib/format';
import { useDataVersion } from '../../state/dataVersion';
import { useToast } from '../../state/toast';

const ITEM_KIND: Record<IngestJobView['items'][number]['status'], ChipKind> = { ok: 'ok', failed: 'fail', skipped: '' };
const POLL_MS = 800;

function summaryText(job: IngestJobView): string {
  if (!job.summary) return job.status === 'running' ? 'running...' : (job.error ?? 'no summary');
  const { ok, failed, skipped, rows } = job.summary;
  return `${ok} ok, ${failed} failed, ${skipped} skipped, ${rows} rows`;
}

/** Start an ingest (the only action that touches the network), follow it live, and read its result. */
export function IngestCard({ status }: { status: DataStatusView | undefined }) {
  const start = useMutation();
  const toast = useToast();
  const { bump } = useDataVersion();
  const [jobId, setJobId] = useState<string | null>(null);
  const followed = useRef<string | null>(null);

  // Follow an ingest that is already running when the page opens (or was started elsewhere).
  const lastIngest = status?.lastIngest ?? null;
  useEffect(() => {
    if (lastIngest && lastIngest.status === 'running' && followed.current === null) {
      followed.current = lastIngest.id;
      setJobId(lastIngest.id);
    }
  }, [lastIngest]);

  const job = useResource((signal) => api.ingest(jobId as string, signal), [jobId], {
    enabled: jobId !== null,
    refetchOnWrite: false,
    pollMs: POLL_MS,
    pollWhile: (view) => view.status === 'running',
  });

  const shown: IngestJobView | null = job.data ?? lastIngest;
  const running = shown?.status === 'running';

  // When the followed job finishes, refresh everything that depends on stored data.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current && shown) {
      wasRunning.current = false;
      bump();
    }
  }, [running, shown, bump]);

  const begin = async () => {
    try {
      const created = await api.startIngest({});
      followed.current = created.id;
      setJobId(created.id);
      toast.push('Ingest started.');
    } catch (error) {
      if (isApiError(error) && error.code === 'ingest_running') {
        toast.push('An ingest is already running; showing it.');
        const fresh = await start.run(() => api.dataStatus(), { bump: false });
        const runningJob = fresh?.lastIngest;
        if (runningJob) {
          followed.current = runningJob.id;
          setJobId(runningJob.id);
        }
      } else {
        toast.error(isApiError(error) ? error.message : String(error));
      }
    }
  };

  return (
    <Panel
      title="Ingest"
      actions={
        <button type="button" className="btn primary" onClick={begin} disabled={running || start.busy}>
          {running ? 'Running...' : 'Run ingest now'}
        </button>
      }
    >
      <div className="stack">
        <small>The only action that touches the network; the scan reads the database only.</small>
        {job.error && jobId ? (
          <ErrorBanner error={job.error} onRetry={job.refresh} title="Lost track of the ingest." />
        ) : null}
        {!shown ? (
          <p className="muted">
            No ingest has run yet. Press the button to fetch prices, fundamentals, chains and dates for the stocks you
            watch.
          </p>
        ) : null}
        {shown ? (
          <>
            <div className="row">
              <Chip kind={shown.status === 'done' ? 'ok' : shown.status === 'failed' ? 'fail' : 'blue'}>
                {shown.status}
              </Chip>
              <span>
                Started <b>{dateTime(shown.startedAt)}</b>
                {shown.finishedAt ? <> &middot; finished {dateTime(shown.finishedAt)}</> : null}
              </span>
              <span className="muted">{summaryText(shown)}</span>
              <span className="muted">
                scope:{' '}
                {shown.scope === 'all'
                  ? 'every watched stock'
                  : shown.scope.map((k) => `${k.market}:${k.symbol}`).join(', ')}
              </span>
            </div>
            {shown.error ? (
              <Callout kind="fail" role="alert">
                {shown.error}
              </Callout>
            ) : null}
            {shown.pausedSkipped.length > 0 ? (
              <small>Skipped because paused: {shown.pausedSkipped.join(', ')}</small>
            ) : null}
            {shown.log.length > 0 ? (
              <div className="log" role="log" aria-label="Ingest log">
                {shown.log.join('\n')}
              </div>
            ) : null}
            {shown.items.length > 0 ? (
              <div style={{ overflow: 'auto', maxHeight: 260 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Step</th>
                      <th>Result</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.items.map((item) => (
                      <tr key={`${item.target}-${item.step}`}>
                        <td className="mono">{item.target}</td>
                        <td>{item.step}</td>
                        <td>
                          <Chip kind={ITEM_KIND[item.status]}>{item.status}</Chip>
                        </td>
                        <td className="muted">{item.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
