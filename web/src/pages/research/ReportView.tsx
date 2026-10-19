import { api, links } from '../../api/endpoints';
import { Callout, ErrorBanner } from '../../components/Callout';
import { ScreenTable } from '../../components/ScreenTable';
import { Skeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { Markdown } from '../../lib/markdown';

/** A finished run's report: markdown for AI skills, the screen table for the local quality screen. */
export function ReportView({ runId }: { runId: string }) {
  const run = useResource((signal) => api.researchRun(runId, signal), [runId], { refetchOnWrite: false });
  if (run.loading) return <Skeleton height={160} />;
  if (run.error && !run.data)
    return <ErrorBanner error={run.error} onRetry={run.refresh} title="Could not load the report." />;
  const report = run.data?.report;
  if (!run.data) return null;
  if (!report) return <Callout kind="blue">This run has no report.</Callout>;
  return (
    <div className="stack">
      {report.format === 'markdown' ? (
        <>
          <div className="row">
            <div className="sp" />
            <a className="btn sm" href={links.reportMd(runId)} download>
              Download .md
            </a>
          </div>
          <Markdown source={report.markdown} />
        </>
      ) : (
        <ScreenTable screen={report.screen} />
      )}
    </div>
  );
}
