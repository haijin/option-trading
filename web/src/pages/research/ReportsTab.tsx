import { useState } from 'react';
import { links } from '../../api/endpoints';
import type { ResearchRunView, SkillCatalogView } from '../../api/types';
import { Chip, type ChipKind } from '../../components/Chip';
import { Panel } from '../../components/Panel';
import { dateTime, num } from '../../lib/format';
import { ReportView } from './ReportView';

const STATUS_KIND: Record<ResearchRunView['status'], ChipKind> = {
  queued: '',
  running: 'blue',
  done: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};

/** Every run for the stock, newest first: open one to read it, or download the markdown. */
export function ReportsTab({
  runs,
  catalog,
  symbol,
}: {
  runs: readonly ResearchRunView[];
  catalog: SkillCatalogView;
  symbol: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const nameOf = (run: ResearchRunView) =>
    catalog.skills.find((skill) => skill.id === run.skillId)?.enName ?? run.skillId;
  const opened = runs.find((run) => run.id === openId);

  return (
    <div className="stack">
      <Panel flush title={`Saved reports: ${symbol}`}>
        {runs.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>
            No runs for this name yet. Run a skill on the Run skills tab.
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Started</th>
                <th>Status</th>
                <th className="num">Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className={openId === run.id ? 'clickable' : undefined}>
                  <td>
                    <b>{nameOf(run)}</b>
                  </td>
                  <td className="muted">{dateTime(run.startedAt ?? run.createdAt)}</td>
                  <td>
                    <Chip kind={STATUS_KIND[run.status]}>{run.status}</Chip>
                  </td>
                  <td className="num">{run.costUsd === null ? '-' : `US$${num(run.costUsd, 2)}`}</td>
                  <td>
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!run.hasReport}
                        aria-pressed={openId === run.id}
                        onClick={() => setOpenId(openId === run.id ? null : run.id)}
                      >
                        {openId === run.id ? 'Hide' : 'Open'}
                      </button>
                      {run.hasReport ? (
                        <a className="btn sm" href={links.reportMd(run.id)} download>
                          Download .md
                        </a>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {opened ? (
        <Panel title={`${nameOf(opened)} · ${dateTime(opened.startedAt ?? opened.createdAt)}`}>
          <ReportView runId={opened.id} />
        </Panel>
      ) : null}
    </div>
  );
}
