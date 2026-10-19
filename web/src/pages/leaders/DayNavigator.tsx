import { useState } from 'react';
import type { LeadersView } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { fmtDay, monthOf } from '../../lib/news';
import { LeadersCalendar } from './LeadersCalendar';
import { runsLine } from './leadersLib';

/**
 * Previous and next stored day, the day label (opens a month calendar of the days that have a run), and in an archived
 * day the banner with "Back to today". The page owns the selected day: `onDate(null)` means today.
 */
export function DayNavigator({ view, onDate }: { view: LeadersView; onDate: (day: string | null) => void }) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [month, setMonth] = useState(() => monthOf(view.asOf ?? view.today ?? ''));
  const { asOf, today, prevDay, nextDay, isArchive } = view;
  if (asOf === null || today === null) return null;

  const go = (day: string | null): void => onDate(day === null || day === today ? null : day);
  const toggleCalendar = (): void => {
    if (!calendarOpen) setMonth(monthOf(asOf));
    setCalendarOpen((v) => !v);
  };

  return (
    <div className="ld-daynav">
      <div className="ld-card ld-daybar">
        <button
          type="button"
          className="ld-arrow"
          aria-label="Previous day"
          disabled={prevDay === null}
          onClick={() => go(prevDay)}
        >
          <Icon name="back" size={18} />
        </button>
        <button
          type="button"
          className="ld-day"
          aria-label="Pick a day"
          aria-expanded={calendarOpen}
          onClick={toggleCalendar}
        >
          <span>
            {isArchive ? fmtDay(asOf) : 'Today'}
            <Icon name="calendar" size={14} className="ic cal" />
          </span>
          <small>{runsLine(view)}</small>
        </button>
        <button
          type="button"
          className="ld-arrow"
          aria-label="Next day"
          disabled={nextDay === null}
          onClick={() => go(nextDay)}
        >
          <Icon name="forward" size={18} />
        </button>
      </div>
      {calendarOpen ? (
        <LeadersCalendar
          month={month}
          onMonth={setMonth}
          today={today}
          selected={asOf}
          earliest={null}
          onPick={(day) => {
            go(day);
            setCalendarOpen(false);
          }}
        />
      ) : null}
      {isArchive ? (
        <div className="ld-archive" role="status">
          <span>
            Archived run for <b>{fmtDay(asOf)}</b>: the list as it was computed that evening, with each name's later
            outcome stamped on it.
          </span>
          <button type="button" className="ld-pill" onClick={() => onDate(null)}>
            Back to today
          </button>
        </div>
      ) : null}
    </div>
  );
}
