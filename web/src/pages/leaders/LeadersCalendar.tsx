import { api } from '../../api/endpoints';
import type { LeadersDaysView } from '../../api/types';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../layout/Icon';
import { DOW_SHORT, fmtDayYear, monthGrid, monthLabel, monthOf, shiftMonth } from '../../lib/news';

/**
 * Month grid of the days that have a stored run: a green dot when the day had Setups, an amber one when it had Watch names.
 * Days without a run and future days are disabled; the month arrows stop where the data starts.
 */
export function LeadersCalendar({
  month,
  onMonth,
  today,
  selected,
  earliest,
  onPick,
}: {
  month: string;
  onMonth: (month: string) => void;
  today: string;
  selected: string;
  earliest: string | null;
  onPick: (day: string) => void;
}) {
  const days = useResource<LeadersDaysView>((signal) => api.leadersDays(month, signal), [month]);
  const byDay = new Map((days.data?.days ?? []).map((d) => [d.day, d]));
  const { lead, cells } = monthGrid(month, today, selected);
  const first = days.data?.earliest ?? earliest ?? today;
  const prevOff = shiftMonth(month, -1) < monthOf(first);
  const nextOff = month >= monthOf(today);
  return (
    <fieldset className="ld-card ld-cal" aria-label={`Calendar, ${monthLabel(month)}`}>
      <div className="ld-cal-head">
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
      <div className="ld-cal-grid">
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
          const off = c.future || !info;
          return (
            <button
              key={c.day}
              type="button"
              className={`d${off ? ' off' : ''}${c.selected ? ' sel' : ''}${c.today ? ' today' : ''}`}
              disabled={off}
              aria-pressed={c.selected}
              aria-label={`${fmtDayYear(c.day)}${info ? `, ${info.setups} ${info.setups === 1 ? 'setup' : 'setups'}, ${info.watch} watch` : ', no run'}`}
              onClick={() => onPick(c.day)}
            >
              {c.n}
              <span className="dots" aria-hidden="true">
                {info && info.setups > 0 ? <i className="ld-dot setup" /> : null}
                {info && info.watch > 0 ? <i className="ld-dot watch" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="ld-cal-legend">
        <span>
          <i className="ld-dot setup" />
          Setups
        </span>
        <span>
          <i className="ld-dot watch" />
          Watch
        </span>
        <span>Days with a stored run</span>
      </div>
    </fieldset>
  );
}
