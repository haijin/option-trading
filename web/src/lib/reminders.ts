/**
 * Utility helpers for the Reminders UI. The list itself is built server-side (GET /api/reminders).
 * These pure functions only group and count what the server returns.
 */
import type { ReminderKind, ReminderView } from '../api/types';

export type { ReminderKind, ReminderView };
/** Backward-compat alias. */
export type ReminderItem = ReminderView;
export type ReminderLevel = 'info' | 'warn' | 'fail';

export const KIND_LABELS: Record<ReminderKind, string> = {
  results: 'Results',
  ex_dividend: 'Ex-dividend',
  expiry: 'Expiry',
  alert: 'Alert',
  news: 'Key news',
};

const _LEVEL_ORDER: Record<ReminderLevel, number> = { fail: 0, warn: 1, info: 2 };

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

export interface ReminderGroup {
  label: 'Today' | 'This week' | 'Later';
  items: ReminderView[];
}

export function groupReminders(items: ReminderView[], today: string): ReminderGroup[] {
  const groups: ReminderGroup[] = [
    { label: 'Today', items: [] },
    { label: 'This week', items: [] },
    { label: 'Later', items: [] },
  ];
  for (const item of items) {
    const gap = daysBetween(today, item.date);
    const slot = gap <= 0 ? 0 : gap <= 7 ? 1 : 2;
    (groups[slot] as ReminderGroup).items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** What the bell counts: everything dated today or earlier. */
export function dueToday(items: ReminderView[], today: string): number {
  return items.filter((item) => item.date <= today).length;
}
