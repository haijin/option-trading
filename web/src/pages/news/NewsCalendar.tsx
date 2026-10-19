import { api } from '../../api/endpoints';
import type { NewsDayView, NewsScope } from '../../api/types';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../layout/Icon';
import { DOT_ORDER, DOW_SHORT, fmtDayYear, monthGrid, monthLabel, monthOf, shiftMonth } from '../../lib/news';

/**
 * Month grid with up to three dots a day (blocks, caution, supports, neutral; a faint grey one for stories not judged yet or
 * a day that only has a brief). The dots follow the scope filter; future days are disabled and the month arrows stop where
 * the data starts.
 */
export function NewsCalendar({
  month,
  onMonth,
  today,
  selected,
  earliest,
  scope,
  hideNeutral,
  onPick,
}: {
  month: string;
  onMonth: (month: string) => void;
  today: string;
  selected: string;
  earliest: string | null;
  scope: NewsScope;
  hideNeutral: boolean;
  onPick: (day: string) => void;
}) {
  const days = useResource((signal) => api.newsDays(month, scope, !hideNeutral, signal), [month, scope, hideNeutral]);
  const byDay = new Map<string, NewsDayView>((days.data?.days ?? []).map((d) => [d.day, d]));
  const { lead, cells } = monthGrid(month, today, selected);
  const first = earliest ?? today;
  const prevOff = shiftMonth(month, -1) < monthOf(first);
  const nextOff = month >= monthOf(today);
  return (
    <fieldset className="news-card news-cal" aria-label={`Calendar, ${monthLabel(month)}`}>
      <div className="news-cal-head">
        <button
          type="button"
          onClick={() => onMonth(shiftMonth(month, -1))}
          disabled={prevOff}
          aria-label="Previous month"
        >
          <Icon name="back" size={16} />
        </button>
        <span aria-live="polite">{monthLabel(month)}</span>
        <button type="button" onClick={() => onMonth(shiftMonth(month, 1))} disabled={nextOff} aria-label="Next month">
          <Icon name="forward" size={16} />
        </button>
      </div>
      <div className="news-cal-grid">
        {DOW_SHORT.map((d) => (
          <span key={d} className="dow" aria-hidden="true">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blank leading cells
          <span key={`b${i}`} />
        ))}
        {cells.map((c) => {
          const info = byDay.get(c.day);
          const impacts = info ? DOT_ORDER.filter((k) => info.impacts.includes(k)).slice(0, 3) : [];
          const briefOnly = info?.brief === true && impacts.length === 0;
          return (
            <button
              key={c.day}
              type="button"
              className={`d${c.future ? ' off' : ''}${c.selected ? ' sel' : ''}${c.today ? ' today' : ''}`}
              disabled={c.future}
              aria-pressed={c.selected}
              aria-label={`${fmtDayYear(c.day)}${impacts.length > 0 ? ', has news' : ''}${info?.brief ? ', has a brief' : ''}`}
              onClick={() => onPick(c.day)}
            >
              {c.n}
              <span className="dots" aria-hidden="true">
                {impacts.map((k) => (
                  <i key={k} className={k} />
                ))}
                {briefOnly ? <i className="brief" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="news-cal-legend">
        <span>
          <i className="blocks" />
          Blocks
        </span>
        <span>
          <i className="caution" />
          Caution
        </span>
        <span>
          <i className="supports" />
          Supports
        </span>
        <span>
          <i className="neutral" />
          Neutral
        </span>
        <span>Dots follow the scope filter</span>
      </div>
    </fieldset>
  );
}
