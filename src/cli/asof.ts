import type { ISODate } from '../core/dates';
import { addDays } from '../core/dates';

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * Default `--as-of`: the latest calendar date for which BOTH markets have completed their session. The US close
 * (16:00 ET) is the later one; from 17:00 ET the US date counts, before that the previous date. Weekends and holidays
 * need no handling here: the freshness gate resolves the last trading day on or before this date per market.
 */
export function defaultAsOf(now: Date): ISODate {
  const parts = Object.fromEntries(FMT.formatToParts(now).map((p) => [p.type, p.value]));
  const etDate = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) >= 17 ? etDate : addDays(etDate, -1);
}
