import { useEffect, useState } from 'react';
import { api } from '../../api/endpoints';
import type { NewsGroupView, NewsScope } from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { useDebounced } from '../../hooks/useDebounced';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../layout/Icon';
import { fmtDay, hkTime, monthOf, windowPhrase, windowPrefix } from '../../lib/news';
import { toHash } from '../../lib/route';
import { tickerLabel } from '../../lib/symbols';
import { BriefCard, briefSummary } from './BriefCard';
import { DayNavigator } from './DayNavigator';
import { StockGroup } from './StockGroup';

const SCOPES: { id: NewsScope; label: string }[] = [
  { id: 'shortlist', label: 'Shortlist' },
  { id: 'positions', label: 'Positions' },
  { id: 'all', label: 'All watched' },
];
const WINDOWS = [
  { days: 1, label: '24h' },
  { days: 3, label: '3 days' },
  { days: 7, label: 'Week' },
  { days: 30, label: 'Month' },
];

/** Hong Kong's calendar date right now: the page's "today" until the server has answered. */
const hkToday = (): string => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

function EmptyScope({ scope, hasNames }: { scope: NewsScope; hasNames: boolean }) {
  if (hasNames) return <div className="news-empty">Nothing in this window for these names.</div>;
  return (
    <div className="news-empty">
      {scope === 'shortlist' ? (
        <>
          No names on the shortlist yet: run the scan on <a href={toHash({ page: 'puts' })}>Puts</a>, then the stories
          for the names it recommends appear here.
        </>
      ) : scope === 'positions' ? (
        <>
          No open puts. Log a fill on <a href={toHash({ page: 'positions' })}>Positions</a> and its stories appear here.
        </>
      ) : (
        <>
          You are not watching any stock. Add some on <a href={toHash({ page: 'watchlist' })}>Watchlist</a>.
        </>
      )}
    </div>
  );
}

export function NewsPage() {
  const [scope, setScope] = useState<NewsScope>('shortlist');
  const [days, setDays] = useState(3);
  const [hideNeutral, setHideNeutral] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => monthOf(hkToday()));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [briefOpen, setBriefOpen] = useState(true);
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());
  const refresh = useMutation();

  const q = useDebounced(query.trim(), 250);
  const searching = searchOpen && q.length > 0;

  const news = useResource(
    (signal) => api.news({ scope, days, date: picked ?? undefined, neutral: !hideNeutral }, signal),
    [scope, days, picked, hideNeutral],
    { pollWhile: (d) => d.status.refreshing, pollMs: 3000 },
  );
  const found = useResource((signal) => api.newsSearch(q, scope, signal), [q, scope], { enabled: searching });

  const today = news.data?.today ?? hkToday();
  const date = picked && picked < today ? picked : today;
  const past = date !== today;
  const brief = useResource((signal) => api.newsBrief(date, signal), [date]);

  // Another day or scope shows other stories: start them collapsed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on these changes only
  useEffect(() => setOpenIds(new Set()), [date, scope]);

  const toggle = (id: number): void =>
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const data = news.data;
  const status = data?.status;
  const busy = refresh.busy || status?.refreshing === true;
  const scopeLabel = scope === 'all' ? 'all watched names' : scope;

  const groups: NewsGroupView[] = searching ? (found.data?.groups ?? []) : (data?.groups ?? []);
  const total = searching ? (found.data?.total ?? 0) : (data?.total ?? 0);

  const onRefresh = (): void => {
    void refresh.run(() => api.refreshNews(), { success: (r) => r.message });
  };

  return (
    <div className="page news">
      <div className="news-head">
        <span className="asof" aria-live="polite">
          {past
            ? 'Archive'
            : status?.fetchedAt
              ? `Fetched ${hkTime(status.fetchedAt)} HKT`
              : news.loading
                ? 'Loading'
                : 'Nothing fetched yet'}
        </span>
        <span className="sub">Market brief, then the stories that touch your names</span>
        <button type="button" className="btn sm" onClick={onRefresh} disabled={busy} aria-label="Refresh news">
          <Icon name="scan" size={16} className={busy ? 'ic spin' : 'ic'} />
          {busy ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {status?.lastFetch?.status === 'failed' ? (
        <Callout kind="fail" role="status">
          <b>The last fetch failed.</b> {status.lastFetch.detail ?? ''} The stories below are the ones already stored.
        </Callout>
      ) : null}

      <div className="news-cols">
        <div className="news-left">
          <DayNavigator
            date={date}
            today={today}
            earliest={status?.earliestDay ?? null}
            onDate={(d) => setPicked(d === today ? null : d)}
            calendarOpen={calendarOpen}
            onCalendarOpen={setCalendarOpen}
            calendarMonth={calendarMonth}
            onCalendarMonth={setCalendarMonth}
            searchOpen={searchOpen}
            onSearchOpen={setSearchOpen}
            query={query}
            onQuery={setQuery}
            scope={scope}
            hideNeutral={hideNeutral}
          />

          <section className={`news-sec${briefOpen ? '' : ' closed'}`} aria-label="Market brief">
            <button type="button" className="news-sh" aria-expanded={briefOpen} onClick={() => setBriefOpen((v) => !v)}>
              <Icon name="chevron" size={18} className="chev" />
              <h2>Market brief</h2>
              <span className="cnt">{briefSummary(brief.data, date)}</span>
            </button>
            {briefOpen ? (
              <div className="news-card news-brief">
                {brief.loading ? (
                  <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
                    <Skeleton width="90%" height={18} />
                    <Skeleton height={30} />
                    <Skeleton height={64} />
                  </div>
                ) : brief.error && !brief.data ? (
                  <ErrorBanner error={brief.error} onRetry={brief.refresh} title="Could not load the brief." />
                ) : brief.data ? (
                  <BriefCard
                    key={`${date}-${brief.data.briefs.map((b) => b.id).join(',')}`}
                    day={brief.data}
                    date={date}
                    today={today}
                    aiAvailable={status?.ai.available ?? false}
                  />
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        <div className="news-right">
          <div className="news-filters">
            <div className="news-seg" role="tablist" aria-label="Which stocks">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={scope === s.id}
                  className={scope === s.id ? 'on' : ''}
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                  {data ? <small>{data.counts[s.id]}</small> : null}
                </button>
              ))}
            </div>
            {searching ? null : (
              <div className="news-winrow">
                <span>{windowPrefix(date, today)}</span>
                <fieldset className="w" aria-label="Time window">
                  {WINDOWS.map((w) => (
                    <button
                      key={w.days}
                      type="button"
                      className={days === w.days ? 'on' : ''}
                      aria-pressed={days === w.days}
                      onClick={() => setDays(w.days)}
                    >
                      {w.label}
                    </button>
                  ))}
                </fieldset>
                <label>
                  <input type="checkbox" checked={hideNeutral} onChange={(e) => setHideNeutral(e.target.checked)} />{' '}
                  Hide neutral
                </label>
              </div>
            )}
            <div className="news-resline" aria-live="polite">
              {searching ? (
                found.loading ? (
                  'Searching…'
                ) : (
                  <>
                    <b>{total}</b> {total === 1 ? 'story' : 'stories'} matching “{q}” across all days, {scopeLabel}
                  </>
                )
              ) : data ? (
                <>
                  <b>{total}</b> {total === 1 ? 'story' : 'stories'} {windowPhrase(days, date, today)}
                </>
              ) : null}
              {!searching && !past && status && status.unclassified > 0 ? (
                <span className="news-judge">
                  {' · '}
                  {status.unclassified} not judged yet
                  {!status.ai.available
                    ? ' (no AI executor on this machine)'
                    : status.ai.auto
                      ? ''
                      : ' (automatic judging is off: Refresh judges them)'}
                </span>
              ) : null}
            </div>
          </div>

          {news.error && !news.data ? (
            <ErrorBanner error={news.error} onRetry={news.refresh} title="Could not load the news." />
          ) : news.loading || (searching && found.loading && !found.data) ? (
            <ListSkeleton rows={4} />
          ) : (
            <div className="news-groups">
              {groups.map((g) => (
                <StockGroup
                  key={`${g.market}:${g.symbol}`}
                  group={g}
                  date={date}
                  today={today}
                  q={searching ? q : ''}
                  openIds={openIds}
                  onToggle={toggle}
                />
              ))}
              {!searching && data && data.quiet.length > 0 && groups.length > 0 ? (
                <div className="news-card news-quiet">
                  <b className="lbl">Nothing {windowPhrase(days, date, today)}:</b>{' '}
                  {data.quiet.map((n) => tickerLabel(n.market, n.symbol)).join(' · ')}
                </div>
              ) : null}
              {!searching && data && groups.length === 0 ? (
                <>
                  {data.quiet.length > 0 ? (
                    <div className="news-card news-quiet">
                      <b className="lbl">Nothing {windowPhrase(days, date, today)}:</b>{' '}
                      {data.quiet.map((n) => tickerLabel(n.market, n.symbol)).join(' · ')}
                    </div>
                  ) : null}
                  <EmptyScope scope={scope} hasNames={data.quiet.length > 0} />
                </>
              ) : null}
              {searching && found.data && groups.length === 0 ? (
                <div className="news-empty">No headlines match “{q}”.</div>
              ) : null}
            </div>
          )}
        </div>

        <p className="news-foot">
          Headlines come from Yahoo Finance, HKEXnews and market feeds; the one-line impact is written by the model
          against your rules at the time and always links to its source. Past days show the standing the name had on
          that day. Decision support only, not investment advice.
          {status?.ai.available
            ? ` Model ${status.ai.model}; today's spend US$${status.ai.spentTodayUsd.toFixed(2)} of US$${status.ai.budgetUsd.toFixed(2)}.`
            : ''}
        </p>
      </div>
      {past ? <span className="sr-only">Showing the archive for {fmtDay(date)}</span> : null}
    </div>
  );
}
