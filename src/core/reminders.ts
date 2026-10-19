import type { Market } from './calendar';
import type { ISODate } from './dates';

export type ReminderKind = 'results' | 'ex_dividend' | 'expiry' | 'alert' | 'news';
export type ReminderLevel = 'info' | 'warn' | 'fail';

export interface ReminderView {
  id: string;
  date: ISODate;
  time?: string;
  market: Market;
  symbol: string;
  kind: ReminderKind;
  level: ReminderLevel;
  title: string;
  why: string;
  href: string;
}

export interface RemindersView {
  asOf: ISODate;
  today: ReminderView[];
  upcoming: ReminderView[];
}
