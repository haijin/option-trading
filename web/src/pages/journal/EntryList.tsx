import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/endpoints';
import type { JournalCardView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { useDebounced } from '../../hooks/useDebounced';
import { useResource } from '../../hooks/useResource';
import { weekOf } from './dates';
import { LessonsView } from './LessonsView';
import { EntryCard, SummaryLine, WeekStrip } from './ListParts';
import { MonthView } from './MonthView';
import { isFiltering, type JournalSearch, parseSearch } from './search';

type Segment = 'entries' | 'month' | 'lessons';

/** Newest-first merge of two lists of cards, one card per day (the first list wins: it is the fresher one). */
export function mergeEntries(fresh: JournalCardView[], older: JournalCardView[]): JournalCardView[] {
  const seen = new Set(fresh.map((e) => e.date));
  const oldest = fresh.length > 0 ? (fresh[fresh.length - 1] as JournalCardView).date : '9999-12-31';
  const rest = older.filter((e) => !seen.has(e.date) && e.date < oldest);
  return [...fresh, ...rest];
}

/**
 * The entry cards for a search, newest first, a page at a time. Saving elsewhere refetches the first page and keeps the
 * older pages already loaded, so the list does not jump while the editor autosaves beside it.
 */
function usePagedEntries(search: JournalSearch, today: string, refreshKey: number) {
  const key = `${search.q}|${search.symbol ?? ''}|${search.tag ?? ''}`;
  const first = useResource(
    (signal) => api.journalEntries({ q: search.q, symbol: search.symbol, tag: search.tag, today, page: 1 }, signal),
    [key, today],
    { refetchOnWrite: false, softDeps: [refreshKey] },
  );
  const [more, setMore] = useState<{ key: string; entries: JournalCardView[]; page: number }>({
    key,
    entries: [],
    page: 1,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const older = more.key === key ? more : { key, entries: [] as JournalCardView[], page: 1 };
  const entries = useMemo(() => mergeEntries(first.data?.entries ?? [], older.entries), [first.data, older.entries]);
  const total = first.data?.total ?? 0;

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setMoreError(null);
    const page = older.page + 1;
    try {
      const view = await api.journalEntries({ q: search.q, symbol: search.symbol, tag: search.tag, today, page });
      if (keyRef.current !== key) return;
      setMore({ key, entries: mergeEntries(older.entries, view.entries), page });
    } catch (error) {
      setMoreError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoadingMore(false);
    }
  }, [older.page, older.entries, search.q, search.symbol, search.tag, today, key]);

  return { first, entries, hasMore: entries.length < total, loadMore, loadingMore, moreError };
}

/**
 * The list pane: search, this week, the month's numbers and three views (entries, month, lessons). Tapping a day or a
 * card asks the page to open that day; "+ New entry" opens today.
 */
export function EntryList({
  today,
  selected,
  refreshKey,
  onOpen,
  onNew,
}: {
  today: string;
  /** The day open in the editor (desktop shows it beside the list). */
  selected: string | undefined;
  /** Bumped when an entry changed somewhere (saved, restored, deleted): the list refetches. */
  refreshKey: number;
  onOpen: (date: string) => void;
  /** Today's entry was asked for; `exists` says it already has one (the page then says so). */
  onNew: (exists: boolean) => void;
}) {
  const [text, setText] = useState('');
  const debounced = useDebounced(text, 250);
  const search = useMemo(() => parseSearch(debounced), [debounced]);
  const filtering = isFiltering(search);
  const [segment, setSegment] = useState<Segment>('entries');
  const list = usePagedEntries(search, today, refreshKey);

  // A search always shows its results in the Entries view.
  useEffect(() => {
    if (filtering) setSegment('entries');
  }, [filtering]);

  const week = useMemo(() => weekOf(today), [today]);
  const weekFrom = week[0]?.date ?? today;
  const weekTo = week[6]?.date ?? today;
  const weekData = useResource(
    (signal) => api.journalEntries({ from: weekFrom, to: weekTo, today }, signal),
    [weekFrom, weekTo, today],
    { refetchOnWrite: false, softDeps: [refreshKey] },
  );
  const hasEntry = useMemo(() => new Set((weekData.data?.entries ?? []).map((e) => e.date)), [weekData.data]);

  // the month's numbers do not depend on the search, so the unfiltered week request is the first choice
  const summary = weekData.data?.summary ?? list.first.data?.summary;
  const lessonCount = summary?.lessons;

  return (
    <div className="jr-listpane">
      <header className="jr-listhead">
        <h1>Journal</h1>
        <button type="button" className="jr-new" onClick={() => onNew(hasEntry.has(today))}>
          + New entry
        </button>
      </header>

      <div className="jr-listbody">
        <div className="jr-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search notes, $0700.HK, #lesson"
            aria-label="Search entries"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <WeekStrip days={week} today={today} selected={selected} has={hasEntry} onOpen={onOpen} />

        {summary ? <SummaryLine summary={summary} /> : <Skeleton height={18} width="70%" />}

        <div className="jr-seg" role="tablist" aria-label="Journal views">
          {(
            [
              ['entries', 'Entries'],
              ['month', 'Month'],
              ['lessons', 'Lessons'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={segment === id}
              className={segment === id ? 'on' : ''}
              onClick={() => setSegment(id)}
            >
              {label}
              {id === 'lessons' && lessonCount !== undefined ? <small>{lessonCount}</small> : null}
            </button>
          ))}
        </div>

        {segment === 'entries' ? (
          <div className="jr-entries" role="tabpanel">
            {list.first.loading ? <ListSkeleton rows={4} /> : null}
            {list.first.error && !list.first.data ? (
              <ErrorBanner error={list.first.error} onRetry={list.first.refresh} title="Could not load the journal." />
            ) : null}
            {list.first.data && list.entries.length === 0 ? (
              <p className="jr-empty">
                {filtering
                  ? 'No entry matches. Try a name like $NKE or a tag like #breach.'
                  : 'No entries yet. Tap + New entry to write today’s.'}
              </p>
            ) : null}
            {list.entries.map((entry) => (
              <EntryCard
                key={entry.date}
                entry={entry}
                selected={entry.date === selected}
                onOpen={() => onOpen(entry.date)}
              />
            ))}
            {list.moreError ? (
              <ErrorBanner error={list.moreError} onRetry={() => void list.loadMore()} title="Could not load more." />
            ) : null}
            {list.hasMore && !list.moreError ? (
              <button
                type="button"
                className="btn jr-more-btn"
                disabled={list.loadingMore}
                onClick={() => void list.loadMore()}
              >
                {list.loadingMore ? 'Loading…' : 'Show older entries'}
              </button>
            ) : null}
          </div>
        ) : null}

        {segment === 'month' ? (
          <MonthView today={today} selected={selected} refreshKey={refreshKey} onOpen={onOpen} />
        ) : null}
        {segment === 'lessons' ? <LessonsView refreshKey={refreshKey} onOpen={onOpen} /> : null}

        <p className="jr-foot">One entry per day. Drafts save as you type.</p>
      </div>
    </div>
  );
}
