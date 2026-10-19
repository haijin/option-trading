import { useMemo, useState } from 'react';
import { api } from '../../api/endpoints';
import type { LeaderCandidateView, LeaderStage, LeadersView } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Skeleton } from '../../components/Skeleton';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { fmtDay, hkTime } from '../../lib/news';
import { toHash } from '../../lib/route';
import { useToast } from '../../state/toast';
import { CandidateCard, type CardActions } from './CandidateCard';
import { DayNavigator } from './DayNavigator';
import { DroppedCard } from './DroppedCard';
import { Filters } from './Filters';
import { Funnel } from './Funnel';
import { InvestigateSheet } from './InvestigateSheet';
import { LeadersHeader } from './LeadersHeader';
import {
  filterCandidates,
  hkDay,
  type MarketFilter,
  type SortKey,
  type StateFilter,
  sortCandidates,
} from './leadersLib';
import { RecordCard } from './RecordCard';
import { ShortlistTable } from './ShortlistTable';

const MUTE_DAYS = 10;

const STAGE_TEXT: Record<LeaderStage, string> = {
  screened: 'screened',
  leaders: 'leaders',
  consolidating: 'in a valid base',
  shortlist: 'shortlist',
};

function PageSkeleton() {
  return (
    <div className="ld-body" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="span2">
        <Skeleton height={150} />
      </div>
      <div className="span2">
        <Skeleton height={58} />
      </div>
      <Skeleton height={340} />
      <Skeleton height={340} />
    </div>
  );
}

function NoRun() {
  return (
    <div className="ld-card ld-empty">
      <p>
        <b>No scan yet.</b> Run one from Refresh, or <code>pnpm cli leaders scan</code>.
      </p>
    </div>
  );
}

/** Banners for what the list cannot promise: a stale run, a failed or partial scan, no equity to size with. */
function Notices({ view }: { view: LeadersView }) {
  const { status, runs } = view;
  const bad = (['US', 'HK'] as const).flatMap((m) => {
    const run = runs[m];
    if (!run || (run.status !== 'failed' && run.status !== 'partial')) return [];
    return [{ m, run }];
  });
  return (
    <>
      {status.stale && !view.isArchive ? (
        <Callout kind="" role="status">
          <b>This list is out of date.</b>{' '}
          {status.lastRunAt
            ? `The newest run finished ${fmtDay(hkDay(status.lastRunAt))} ${hkTime(status.lastRunAt)} HKT. `
            : ''}
          Use Refresh to scan again.
        </Callout>
      ) : null}
      {bad.map(({ m, run }) => (
        <Callout key={m} kind={run.status === 'failed' ? 'fail' : ''} role="status">
          <b>
            The {m} scan {run.status === 'failed' ? 'failed' : 'finished with gaps'}.
          </b>{' '}
          {run.coverage ? `${run.coverage.withBar} of ${run.coverage.names} names had a bar for the day. ` : ''}
          What is shown is what the scan could compute.
        </Callout>
      ))}
      {status.equityMissing ? (
        <Callout
          kind="blue"
          action={
            <a className="btn sm" href={toHash({ page: 'settings' })}>
              Open Settings
            </a>
          }
        >
          <b>Equity is not set.</b> Plans show prices and levels but no share counts.
        </Callout>
      ) : null}
    </>
  );
}

function CandidateList({
  view,
  rows,
  actions,
  onBack,
}: {
  view: LeadersView;
  rows: LeaderCandidateView[];
  actions: CardActions;
  onBack: () => void;
}) {
  const stage = view.stage;
  if (stage !== 'shortlist' && view.candidates.length === 0) {
    return (
      <div className="ld-card ld-empty">
        <p>{view.stageNote ?? `No names are stored for the "${STAGE_TEXT[stage]}" stage.`}</p>
        <button type="button" className="ld-pill" onClick={onBack}>
          Back to the shortlist
        </button>
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="ld-card ld-empty">Nothing matches these filters.</div>;
  }
  return (
    <>
      {stage !== 'shortlist' ? (
        <div className="ld-stagebar">
          <span>
            Names that stopped at <b>{STAGE_TEXT[stage]}</b>, with the rule each one failed.{' '}
            {view.stageNote ? view.stageNote : ''}
          </span>
          <button type="button" className="ld-pill" onClick={onBack}>
            Back to the shortlist
          </button>
        </div>
      ) : null}
      {stage === 'shortlist' ? (
        <ShortlistTable rows={rows} actions={actions} />
      ) : (
        rows.map((c) => <CandidateCard key={c.id} c={c} actions={actions} />)
      )}
    </>
  );
}

const FOOT =
  "Method: Martin Luk's pullback buy (screen for leaders, map support, stop and size first, 3R and 5R partials). Universe: S&P 500, Nasdaq-100, S&P 400, Hang Seng, H-share, TECH and Composite constituents; bars from Yahoo after each close. The list is computed by a versioned skill from stored bars; any one-line model note is written from the skill's numbers and dropped if it adds a number of its own. Decision support only. The app never places orders.";

/**
 * Leaders: the daily shortlist of market leaders that pulled back to support (docs/designs/leaders-pullback.md). Reached from
 * the Today card or Settings, not from a tab. Filters and sort work on the names already returned; the funnel stage and the
 * day are asked from the server.
 */
export function LeadersPage() {
  const [date, setDate] = useState<string | null>(null);
  const [stage, setStage] = useState<LeaderStage>('shortlist');
  const [market, setMarket] = useState<MarketFilter>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [sort, setSort] = useState<SortKey>('score');
  const [investigating, setInvestigating] = useState<LeaderCandidateView | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const refresh = useMutation();
  const act = useMutation();
  const toast = useToast();

  // The day and the stage keep the previous list on screen while the next one loads, so the page does not flash.
  const view = useResource((signal) => api.leaders({ date: date ?? undefined, stage }, signal), [], {
    softDeps: [date, stage],
    pollWhile: (d) => d.status.refreshing,
    pollMs: 3000,
  });
  const data = view.data;

  const rows = useMemo(() => {
    if (!data) return [];
    const visible = data.candidates.filter((c) => !hidden.has(c.id));
    const filtered = filterCandidates(visible, market, data.stage === 'shortlist' ? state : 'all');
    return sortCandidates(filtered, sort);
  }, [data, hidden, market, state, sort]);

  const setDay = (day: string | null): void => {
    setDate(day);
    setStage('shortlist');
  };

  const unmute = async (c: LeaderCandidateView): Promise<void> => {
    const done = await act.run(() => api.unmuteLeader(c.id), { success: `${c.symbol} is back on the list` });
    if (!done) return;
    setHidden((cur) => {
      const next = new Set(cur);
      next.delete(c.id);
      return next;
    });
  };

  const actions: CardActions = {
    busy: act.busy,
    onInvestigate: setInvestigating,
    onWatch: (c) => {
      void act.run(() => api.watchLeader(c.id), { success: (r) => `${r.symbol} added to the watchlist` });
    },
    onMute: (c) => {
      void (async () => {
        const muted = await act.run(() => api.muteLeader(c.id, { days: MUTE_DAYS }));
        if (!muted) return;
        setHidden((cur) => new Set(cur).add(c.id));
        toast.push(`${c.symbol} muted for ${muted.days} trading ${muted.days === 1 ? 'day' : 'days'}`, 'info', {
          actionLabel: 'Undo',
          onAction: () => void unmute(c),
        });
      })();
    },
  };

  const busy = refresh.busy || data?.status.refreshing === true;
  const onRefresh = (): void => {
    void refresh.run(() => api.refreshLeaders(), { success: (r) => r.message });
  };

  const hasRun = data ? data.asOf !== null : false;

  return (
    <div className="page ld">
      <LeadersHeader view={data} loading={view.loading} busy={busy} onRefresh={onRefresh} />

      {view.error && !data ? (
        <ErrorBanner error={view.error} onRetry={view.refresh} title="Could not load the leaders." />
      ) : view.loading ? (
        <PageSkeleton />
      ) : data ? (
        <div className="ld-body">
          {view.error ? (
            <ErrorBanner error={view.error} onRetry={view.refresh} title="Could not refresh the leaders." />
          ) : null}
          <Notices view={data} />
          {hasRun ? (
            <>
              <div className="span2">
                <Funnel funnel={data.funnel} stage={stage} onStage={setStage} archive={data.isArchive} />
              </div>
              <div className="span2">
                <DayNavigator view={data} onDate={setDay} />
              </div>
              {data.brief ? (
                <p className="ld-lead span2">
                  {data.brief.lead}
                  {data.brief.model ? <small> Model note · {data.brief.model}</small> : null}
                </p>
              ) : null}
              <div className="span2">
                <Filters
                  market={market}
                  onMarket={setMarket}
                  state={state}
                  onState={setState}
                  sort={sort}
                  onSort={setSort}
                  showState={data.stage === 'shortlist'}
                />
              </div>
              <div
                className={`ld-list span2${view.refreshing ? ' busy' : ''}`}
                aria-busy={view.refreshing || undefined}
              >
                <CandidateList view={data} rows={rows} actions={actions} onBack={() => setStage('shortlist')} />
              </div>
              <DroppedCard dropped={data.dropped} archive={data.isArchive} />
              <RecordCard />
            </>
          ) : (
            <div className="span2">
              <NoRun />
            </div>
          )}
          <p className="ld-foot-note span2">{FOOT}</p>
        </div>
      ) : null}

      {investigating ? <InvestigateSheet c={investigating} onClose={() => setInvestigating(null)} /> : null}
    </div>
  );
}
