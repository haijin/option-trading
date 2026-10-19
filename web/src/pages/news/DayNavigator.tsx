import { useEffect, useRef } from 'react';
import type { NewsScope } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { addDays, daySub, fmtDay, monthOf } from '../../lib/news';
import { NewsCalendar } from './NewsCalendar';

/**
 * Previous and next day, the day label (opens the calendar), a search button, and a "Back to today" pill in the archive.
 * Everything is controlled by the page, which owns the selected day.
 */
export function DayNavigator({
  date,
  today,
  earliest,
  onDate,
  calendarOpen,
  onCalendarOpen,
  calendarMonth,
  onCalendarMonth,
  searchOpen,
  onSearchOpen,
  query,
  onQuery,
  scope,
  hideNeutral,
}: {
  date: string;
  today: string;
  earliest: string | null;
  onDate: (day: string) => void;
  calendarOpen: boolean;
  onCalendarOpen: (open: boolean) => void;
  calendarMonth: string;
  onCalendarMonth: (month: string) => void;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  scope: NewsScope;
  hideNeutral: boolean;
}) {
  const past = date !== today;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) input.current?.focus();
  }, [searchOpen]);

  const toggleCalendar = (): void => {
    const next = !calendarOpen;
    if (next) onCalendarMonth(monthOf(date));
    onCalendarOpen(next);
  };

  return (
    <div className="news-daynav">
      {past ? (
        <button type="button" className="news-today-pill" onClick={() => onDate(today)}>
          Back to today
        </button>
      ) : null}
      <div className="news-card news-daybar">
        <button
          type="button"
          className="news-arrow"
          aria-label="Previous day"
          disabled={earliest !== null && date <= earliest}
          onClick={() => onDate(addDays(date, -1))}
        >
          <Icon name="back" size={18} />
        </button>
        <button type="button" className="news-day" aria-label="Pick a day" onClick={toggleCalendar}>
          <span>{past ? fmtDay(date) : 'Today'}</span>
          <small>{daySub(date, today)}</small>
        </button>
        <button
          type="button"
          className="news-arrow"
          aria-label="Next day"
          disabled={!past}
          onClick={() => onDate(addDays(date, 1))}
        >
          <Icon name="forward" size={18} />
        </button>
        <button
          type="button"
          className={`news-ico${calendarOpen ? ' on' : ''}`}
          aria-label="Calendar"
          aria-expanded={calendarOpen}
          onClick={toggleCalendar}
        >
          <Icon name="calendar" size={19} />
        </button>
        <button
          type="button"
          className={`news-ico${searchOpen ? ' on' : ''}`}
          aria-label="Search headlines"
          aria-expanded={searchOpen}
          onClick={() => {
            if (searchOpen) onQuery('');
            onSearchOpen(!searchOpen);
          }}
        >
          <Icon name="research" size={19} />
        </button>
      </div>
      {calendarOpen ? (
        <NewsCalendar
          month={calendarMonth}
          onMonth={onCalendarMonth}
          today={today}
          selected={date}
          earliest={earliest}
          scope={scope}
          hideNeutral={hideNeutral}
          onPick={(day) => {
            onDate(day);
            onCalendarOpen(false);
          }}
        />
      ) : null}
      {searchOpen ? (
        <div className="news-searchrow">
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search headlines, any day (e.g. buyback, 1211, earnings)"
            aria-label="Search headlines"
          />
          <button
            type="button"
            onClick={() => {
              onQuery('');
              input.current?.focus();
            }}
          >
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
