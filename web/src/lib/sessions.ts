/**
 * The two market sessions on one Hong Kong clock, for the Home session card. Pure: takes the instant, never reads it.
 * HK trades 09:30 to 12:00 and 13:00 to 16:00 HKT. The US regular session is 09:30 to 16:00 New York, which is 21:30
 * to 04:00 HKT while New York is on daylight time and 22:30 to 05:00 HKT otherwise. Holidays are not known here.
 */

const HOUR = 60;
const HK_OFFSET_MS = 8 * 3_600_000;

export interface SessionBlock {
  market: 'HK' | 'US';
  /** Minutes since Hong Kong midnight, start inclusive. */
  start: number;
  /** Minutes since Hong Kong midnight, end exclusive. Never crosses midnight: a crossing session is two blocks. */
  end: number;
}

export interface SessionState {
  /** Minutes since Hong Kong midnight. */
  minute: number;
  /** 0 = Sunday, in Hong Kong. */
  weekday: number;
  /** "Friday 17 October", in Hong Kong. */
  dateTitle: string;
  /** "08:40". */
  clock: string;
  blocks: SessionBlock[];
  /** Which session is open now, if any. */
  open: 'HK' | 'US' | null;
  /** "HK opens in 50 min", "US trading, closes 04:00". */
  headline: string;
  /** The other market in one short line: "US closed, reopens 21:30". */
  sub: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Second Sunday of March to the first Sunday of November, by New York calendar date (close enough at 1 h resolution). */
export function newYorkOnDaylightTime(now: Date): boolean {
  const ny = new Date(now.getTime() - 5 * 3_600_000);
  const year = ny.getUTCFullYear();
  const nthSunday = (month: number, n: number): number => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const start = Date.UTC(year, 2, nthSunday(2, 2), 7); // 02:00 EST = 07:00 UTC
  const end = Date.UTC(year, 10, nthSunday(10, 1), 6); // 02:00 EDT = 06:00 UTC
  return now.getTime() >= start && now.getTime() < end;
}

export function hkMinutes(h: number, m = 0): number {
  return h * HOUR + m;
}

export function clockText(minute: number): string {
  const h = Math.floor(minute / HOUR) % 24;
  const m = minute % HOUR;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function durationText(minutes: number): string {
  if (minutes < 1) return 'now';
  if (minutes < HOUR) return `${minutes} min`;
  const h = Math.floor(minutes / HOUR);
  const m = minutes % HOUR;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function sessionBlocks(now: Date): SessionBlock[] {
  const usOpen = newYorkOnDaylightTime(now) ? hkMinutes(21, 30) : hkMinutes(22, 30);
  const usClose = usOpen + 6 * HOUR + 30 - 24 * HOUR; // 04:00 or 05:00 the next morning
  return [
    { market: 'US', start: 0, end: usClose },
    { market: 'HK', start: hkMinutes(9, 30), end: hkMinutes(12) },
    { market: 'HK', start: hkMinutes(13), end: hkMinutes(16) },
    { market: 'US', start: usOpen, end: 24 * HOUR },
  ];
}

export function sessionState(now: Date): SessionState {
  const hk = new Date(now.getTime() + HK_OFFSET_MS);
  const minute = hk.getUTCHours() * HOUR + hk.getUTCMinutes();
  const weekday = hk.getUTCDay();
  const dateTitle = `${WEEKDAYS[weekday]} ${hk.getUTCDate()} ${MONTHS[hk.getUTCMonth()]}`;
  const blocks = sessionBlocks(now);
  const usOpen = (blocks[3] as SessionBlock).start;
  const usClose = (blocks[0] as SessionBlock).end;
  const hkOpen = hkMinutes(9, 30);
  const hkLunch = hkMinutes(12);
  const hkAfternoon = hkMinutes(13);
  const hkClose = hkMinutes(16);
  const usCloseText = clockText(usClose);
  const usOpenText = clockText(usOpen);

  // The US session that started the previous evening is still running early in the morning (Tuesday to Saturday).
  const usOvernight = minute < usClose && weekday >= 2 && weekday <= 6;
  const weekend = weekday === 0 || weekday === 6;

  let open: 'HK' | 'US' | null = null;
  let headline: string;
  let sub: string;
  if (usOvernight) {
    open = 'US';
    headline = `US trading, closes ${usCloseText}`;
    sub = weekend ? 'HK closed until Monday 09:30' : `HK opens in ${durationText(hkOpen - minute)}`;
  } else if (weekend) {
    headline = `Markets closed until Monday 09:30`;
    sub = weekday === 6 ? 'US session ended this morning' : `US reopens Monday ${usOpenText}`;
  } else if (minute < hkOpen) {
    headline = `HK opens in ${durationText(hkOpen - minute)}`;
    sub = `US closed, reopens ${usOpenText}`;
  } else if (minute < hkLunch) {
    open = 'HK';
    headline = 'HK trading, lunch at 12:00';
    sub = `US opens ${usOpenText}`;
  } else if (minute < hkAfternoon) {
    headline = 'HK lunch, reopens 13:00';
    sub = `US opens ${usOpenText}`;
  } else if (minute < hkClose) {
    open = 'HK';
    headline = 'HK trading, closes 16:00';
    sub = `US opens ${usOpenText}`;
  } else if (minute < usOpen) {
    headline = `US opens in ${durationText(usOpen - minute)}`;
    sub = weekday === 5 ? 'HK closed until Monday 09:30' : 'HK closed, reopens 09:30';
  } else {
    open = 'US';
    headline = `US trading, closes ${usCloseText}`;
    sub = weekday === 5 ? 'HK closed until Monday 09:30' : 'HK closed, reopens 09:30';
  }
  return { minute, weekday, dateTitle, clock: clockText(minute), blocks, open, headline, sub };
}
