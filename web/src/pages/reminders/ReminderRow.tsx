import { KIND_LABELS, type ReminderGroup, type ReminderItem } from '../../lib/reminders';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "17" over "Fri" for a day this month, "12 Nov" over "Wed" for a later one. */
export function dateColumn(iso: string, today: string): { big: string; small: string } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  const sameMonth = iso.slice(0, 7) === today.slice(0, 7);
  return { big: sameMonth ? String(d) : `${d} ${MONTHS[m - 1] ?? ''}`, small: weekday };
}

export function ReminderRow({ item, today }: { item: ReminderItem; today: string }) {
  const date = dateColumn(item.date, today);
  const tone = item.level === 'info' ? '' : ` ${item.level}`;
  return (
    <a className={`hm-row rm${tone}`} href={item.href}>
      <span className="rm-d">
        <span className="big">{date.big}</span>
        {date.small}
      </span>
      <span className="rm-t">{item.title}</span>
      <span className="rm-w">{item.why}</span>
      <span className={`rm-tag ${item.kind}`}>{KIND_LABELS[item.kind]}</span>
    </a>
  );
}

export function ReminderGroups({ groups, today }: { groups: ReminderGroup[]; today: string }) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="rm-gh">{group.label}</div>
          {group.items.map((item) => (
            <ReminderRow key={item.id} item={item} today={today} />
          ))}
        </div>
      ))}
    </>
  );
}
