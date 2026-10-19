import { useMemo, useState } from 'react';
import { api } from '../../api/endpoints';
import type { JournalCalendarDayView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { Skeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { addMonths, monthGrid, monthOf, monthTitle, WEEKDAY_LETTERS } from './dates';

const DOT = { bullish: 'b', neutral: 'n', bearish: 'r' } as const;
const VIEW_WORD = { bullish: 'bullish', neutral: 'neutral', bearish: 'bearish' } as const;

/** A calendar for one month: a dot coloured by that day's market view, tap a day to open or start its entry. */
export function MonthView({
  today,
  selected,
  refreshKey,
  onOpen,
}: {
  today: string;
  selected: string | undefined;
  refreshKey: number;
  onOpen: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => monthOf(selected ?? today));
  const calendar = useResource((signal) => api.journalCalendar(month, signal), [month], {
    refetchOnWrite: false,
    softDeps: [refreshKey],
  });
  const cells = useMemo(() => monthGrid(month), [month]);
  const byDate = useMemo(() => {
    const map = new Map<string, JournalCalendarDayView>();
    for (const d of calendar.data?.days ?? []) map.set(d.date, d);
    return map;
  }, [calendar.data]);
  const data = calendar.data;

  return (
    <div className="jr-card jr-monthcard">
      <div className="jr-monthhead">
        <button
          type="button"
          className="jr-step"
          aria-label="Previous month"
          onClick={() => setMonth((m) => addMonths(m, -1))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="jr-monthtitle">
          <b className="jr-mt">{monthTitle(month)}</b>
          <span>
            {data
              ? `${data.entries} ${data.entries === 1 ? 'entry' : 'entries'} · ${data.bullish} bullish · ${data.bearish} bearish`
              : ' '}
          </span>
        </div>
        <button
          type="button"
          className="jr-step"
          aria-label="Next month"
          onClick={() => setMonth((m) => addMonths(m, 1))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {calendar.error && !data ? (
        <ErrorBanner error={calendar.error} onRetry={calendar.refresh} title="Could not load the calendar." />
      ) : null}

      <div className="jr-month" aria-busy={calendar.loading || undefined}>
        {WEEKDAY_LETTERS.map((letter, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the seven weekday letters repeat (T, S) and never change
          <span key={i} className="jr-dow" aria-hidden="true">
            {letter}
          </span>
        ))}
        {cells.map((cell) => {
          if (cell.pad) {
            return (
              <span key={cell.date} className="jr-pad-day" aria-hidden="true">
                {cell.day}
              </span>
            );
          }
          const entry = byDate.get(cell.date);
          const classes = [entry ? 'has' : '', cell.date === today ? 'today' : '', cell.date === selected ? 'sel' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={cell.date}
              type="button"
              className={classes}
              aria-label={`${cell.day} ${monthTitle(month).split(' ')[0]}${entry ? `, entry, ${VIEW_WORD[entry.marketView]}` : ', no entry yet'}`}
              onClick={() => onOpen(cell.date)}
            >
              {cell.day}
              <i className="jr-dots" aria-hidden="true">
                {entry ? <s className={DOT[entry.marketView]} /> : null}
              </i>
            </button>
          );
        })}
      </div>
      {calendar.loading ? <Skeleton height={6} style={{ marginTop: 10 }} /> : null}
      <p className="jr-note">Dot colour is your market view that day. Tap a day to open or start its entry.</p>
    </div>
  );
}
