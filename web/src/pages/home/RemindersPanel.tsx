import { groupReminders } from '../../lib/reminders';
import { toHash } from '../../lib/route';
import { useReminders } from '../../state/reminders';
import { ReminderGroups } from '../reminders/ReminderRow';
import { Empty, HomePanel, type PanelSummary } from './HomePanel';

export function remindersSummary({
  items,
  due,
  loading,
}: {
  items: unknown[];
  due: number;
  loading: boolean;
}): PanelSummary {
  const waiting = loading && items.length === 0;
  return {
    count: waiting ? null : due > 0 ? `${due} today` : String(items.length),
    kind: due > 0 ? 'warn' : items.length > 0 ? 'ok' : 'quiet',
    tile: waiting
      ? null
      : due > 0
        ? { value: String(due), label: 'Due today' }
        : { value: String(items.length), label: 'Coming up' },
  };
}

/** Reminders: today and this week, from the shared list; the page has the rest. */
export function RemindersPanel({ limit }: { limit: number }) {
  const reminders = useReminders();
  const { items, today, loading } = reminders;
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  const summary = remindersSummary(reminders);
  return (
    <HomePanel
      id="remind"
      title="Reminders"
      count={summary.count}
      countKind={summary.kind}
      page="reminders"
      foot={
        items.length > 0 ? (
          <span>{more > 0 ? `${more} more in the next 30 days` : 'Everything in the next 30 days'}</span>
        ) : null
      }
    >
      {shown.length > 0 ? <ReminderGroups groups={groupReminders(shown, today)} today={today} /> : null}
      {!loading && items.length === 0 ? (
        <Empty>
          Nothing in the next 30 days: no results dates on watched names, no expiries, no alerts. Add a results date on{' '}
          <a href={toHash({ page: 'data' })}>Data</a> when you know one.
        </Empty>
      ) : null}
    </HomePanel>
  );
}
