import { describe, expect, it } from 'vitest';
import type { ReminderView } from '../api/types';
import { addDays, daysBetween, dueToday, groupReminders } from './reminders';

const today = '2026-10-17';

const item = (over: Partial<ReminderView>): ReminderView =>
  ({
    id: 'test:1',
    date: today,
    market: 'US',
    symbol: 'TSLA',
    kind: 'alert',
    level: 'info',
    title: 'TSLA: test',
    why: 'some reason',
    href: '#/positions',
    ...over,
  }) as ReminderView;

describe('reminders utilities', () => {
  it('does date arithmetic on ISO days', () => {
    expect(addDays('2026-10-17', 30)).toBe('2026-11-16');
    expect(addDays('2026-10-17', -1)).toBe('2026-10-16');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-17', '2026-10-29')).toBe(12);
    expect(daysBetween('2026-10-29', '2026-10-17')).toBe(-12);
  });

  it('counts items dated today or earlier as due', () => {
    const items = [item({ date: '2026-10-16' }), item({ date: '2026-10-17' }), item({ date: '2026-10-18' })];
    expect(dueToday(items, today)).toBe(2);
  });

  it('groups into today, this week and later', () => {
    const items = [
      item({ date: '2026-10-17', kind: 'alert' }),
      item({ date: '2026-10-21', kind: 'results' }),
      item({ date: '2026-11-20', kind: 'expiry' }),
    ];
    const groups = groupReminders(items, today);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 1],
      ['This week', 1],
      ['Later', 1],
    ]);
  });

  it('omits empty groups', () => {
    const items = [item({ date: '2026-10-17' }), item({ date: '2026-10-18' })];
    const groups = groupReminders(items, today);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'This week']);
  });
});
