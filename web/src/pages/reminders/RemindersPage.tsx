import { useMemo, useState } from 'react';
import { Callout, ErrorBanner } from '../../components/Callout';
import { ListSkeleton } from '../../components/Skeleton';
import { Icon } from '../../layout/Icon';
import { addDays, groupReminders, KIND_LABELS, type ReminderItem, type ReminderKind } from '../../lib/reminders';
import { toHash } from '../../lib/route';
import { useReminders } from '../../state/reminders';
import { ReminderGroups } from './ReminderRow';

const KINDS: ReminderKind[] = ['results', 'ex_dividend', 'expiry', 'alert', 'news'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The next fourteen days with one dot per kind of reminder that falls on them. */
function DayStrip({ items, today }: { items: ReminderItem[]; today: string }) {
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index));
  return (
    <section className="rm-days" aria-label="The next fourteen days">
      {days.map((day) => {
        const [y, m, d] = day.split('-').map(Number) as [number, number, number];
        const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        const kinds = KINDS.filter((kind) => items.some((item) => item.kind === kind && item.date === day));
        const cls = [day === today ? 'today' : '', weekday === 0 || weekday === 6 ? 'weekend' : ''].join(' ').trim();
        return (
          <span
            key={day}
            className={cls ? `rm-day ${cls}` : 'rm-day'}
            title={kinds.map((k) => KIND_LABELS[k]).join(', ') || undefined}
          >
            {WEEKDAYS[weekday]}
            <span className="n">{d}</span>
            {kinds.length > 0 ? kinds.map((kind) => <i key={kind} className={kind} />) : <i />}
          </span>
        );
      })}
    </section>
  );
}

/**
 * Reminders: results dates, expiries, position alerts and key news for the names you hold or the scan recommends,
 * grouped into today, this week and later. Built server-side (GET /api/reminders) since D2.
 */
export function RemindersPage() {
  const { items, today, loading, error, refresh } = useReminders();
  const [off, setOff] = useState<ReadonlySet<ReminderKind>>(new Set());
  const shown = useMemo(() => items.filter((item) => !off.has(item.kind)), [items, off]);
  const groups = useMemo(() => groupReminders(shown, today), [shown, today]);
  const toggle = (kind: ReminderKind) =>
    setOff((cur) => {
      const next = new Set(cur);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  if (loading && items.length === 0) {
    return (
      <div className="page">
        <ListSkeleton rows={5} />
      </div>
    );
  }
  if (error && items.length === 0) {
    return (
      <div className="page">
        <ErrorBanner error={error} onRetry={refresh} title="Could not load the reminders." />
      </div>
    );
  }

  return (
    <div className="page reminders">
      <DayStrip items={items} today={today} />
      <section className="rm-filters" aria-label="Show">
        {KINDS.map((kind) => {
          const count = items.filter((item) => item.kind === kind).length;
          return (
            <button key={kind} type="button" aria-pressed={!off.has(kind)} onClick={() => toggle(kind)}>
              {KIND_LABELS[kind]} {count}
            </button>
          );
        })}
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={refresh}
          aria-label="Refresh reminders"
        >
          <Icon name="scan" size={16} />
          Refresh
        </button>
      </section>
      {groups.length === 0 ? (
        <Callout kind="blue">
          {items.length === 0 ? (
            <>
              Nothing to remind you of in the next 30 days: no results dates, no ex-dividend dates, no expiries, no
              alerts and no blocking news. Results and ex-dividend dates come from the{' '}
              <a href={toHash({ page: 'data' })}>Data</a> page's events; add one there if you know it.
            </>
          ) : (
            'Every kind is hidden. Turn one back on above.'
          )}
        </Callout>
      ) : (
        <section className="hm-mod" aria-label="Upcoming">
          <ReminderGroups groups={groups} today={today} />
        </section>
      )}
      <p className="rm-sources">
        Results and ex-dividend dates come from the stored corporate events (Yahoo's calendar, HKEX notices you add). HK
        dates often arrive late and are marked unconfirmed until the board-meeting notice. Expiries and alerts come from
        your open puts; key news from the stories classified in the last day. Nothing here is advice.
      </p>
    </div>
  );
}
