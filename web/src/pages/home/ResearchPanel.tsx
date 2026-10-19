import type { ResearchRunView, SkillCatalogView } from '../../api/types';
import { Chip } from '../../components/Chip';
import type { Resource } from '../../hooks/useResource';
import { shortDate } from '../../lib/format';
import { toHash } from '../../lib/route';
import { Empty, HomePanel, PanelState, type PanelSummary } from './HomePanel';

const WEEK_MS = 7 * 86_400_000;

export const isActive = (run: ResearchRunView): boolean => run.status === 'running' || run.status === 'queued';

function skillName(catalog: SkillCatalogView | undefined, id: string): { zh: string; en: string } {
  const skill = catalog?.skills.find((s) => s.id === id);
  return skill ? { zh: skill.zhName, en: skill.enName } : { zh: id, en: '' };
}

function RunBlock({ run, catalog }: { run: ResearchRunView; catalog: SkillCatalogView | undefined }) {
  const name = skillName(catalog, run.skillId);
  const total = Math.max(run.steps.length, 1);
  return (
    <a className="hm-run" href={toHash({ page: 'research', market: run.market, symbol: run.symbol })}>
      <span className="rl">
        <span className="hm-spin" aria-hidden="true" />
        <b className="rsym">{run.symbol}</b>
        <span className="nm">
          {name.zh}
          {name.en ? <small> {name.en}</small> : null}
        </span>
        <Chip>{run.status === 'queued' ? 'queued' : 'running'}</Chip>
      </span>
      <span className="hm-steps" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length step segments
          <i key={i} className={i < run.stepIndex ? 'done' : i === run.stepIndex ? 'now' : ''} />
        ))}
      </span>
      <small>
        {run.steps.length > 0
          ? `Step ${Math.min(run.stepIndex + 1, total)} of ${total}: ${run.steps[Math.min(run.stepIndex, total - 1)] ?? ''}`
          : 'Starting'}
      </small>
    </a>
  );
}

function ReportRow({ run, catalog }: { run: ResearchRunView; catalog: SkillCatalogView | undefined }) {
  const name = skillName(catalog, run.skillId);
  const failed = run.status === 'failed';
  return (
    <a className="hm-row rp" href={toHash({ page: 'research', market: run.market, symbol: run.symbol })}>
      <span className="sym">
        <b>{run.symbol}</b>
        <span className="mk">{run.market}</span>
      </span>
      <span className="skn">
        {name.zh}
        {name.en ? <small>{name.en}</small> : null}
      </span>
      <span className="v">
        <Chip kind={failed ? 'fail' : run.hasReport ? 'ok' : ''}>
          {failed ? 'failed' : (run.verdict ?? (run.hasReport ? 'report ready' : run.status))}
        </Chip>
        <small>{run.finishedAt ? shortDate(run.finishedAt.slice(0, 10)) : ''}</small>
      </span>
    </a>
  );
}

/** The runs that are going and the finished ones from the last seven days, from the one list Home fetches. */
function splitRuns(all: ResearchRunView[]) {
  const active = all.filter(isActive);
  const finished = all.filter((r) => !isActive(r) && r.status !== 'cancelled');
  const since = Date.now() - WEEK_MS;
  const week = finished.filter((r) => r.finishedAt && new Date(r.finishedAt).getTime() >= since);
  return { active, finished, week };
}

export function researchSummary(runs: Resource<ResearchRunView[]>): PanelSummary {
  if (!runs.data) return { count: null, kind: 'quiet', tile: null };
  const { active, week } = splitRuns(runs.data);
  return {
    count: active.length > 0 ? `${active.length} running` : `${week.length} this week`,
    kind: active.length > 0 || week.length > 0 ? 'ok' : 'quiet',
    tile:
      active.length > 0
        ? { value: String(active.length), label: 'Running' }
        : { value: String(week.length), label: week.length === 1 ? 'Report' : 'Reports' },
  };
}

/** Research: what is running now, then the latest finished reports. */
export function ResearchPanel({
  runs,
  catalog,
  limit,
}: {
  runs: Resource<ResearchRunView[]>;
  catalog: Resource<SkillCatalogView>;
  limit: number;
}) {
  const all = runs.data ?? [];
  const { active, finished, week } = splitRuns(all);
  const cost = week.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const summary = researchSummary(runs);
  return (
    <HomePanel
      id="research"
      title="Research"
      count={summary.count}
      countKind={summary.kind}
      page="research"
      foot={
        runs.data ? (
          <>
            <span>
              {week.length} {week.length === 1 ? 'report' : 'reports'} this week
            </span>
            {cost > 0 ? <span className="right">US$ {cost.toFixed(2)} this week</span> : null}
          </>
        ) : null
      }
    >
      <PanelState resource={runs} title="Could not load the research runs." />
      {active.map((run) => (
        <RunBlock key={run.id} run={run} catalog={catalog.data} />
      ))}
      <div className="hm-rp-grid">
        {finished.slice(0, limit).map((run) => (
          <ReportRow key={run.id} run={run} catalog={catalog.data} />
        ))}
      </div>
      {runs.data && all.length === 0 ? (
        <Empty>
          No research yet. Open a stock on Research and start from a preset; the quality screen is local and free.
        </Empty>
      ) : null}
    </HomePanel>
  );
}
