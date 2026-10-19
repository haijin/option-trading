/**
 * The market tape on the brief card: S&P 500, HSI, VIX, VHSI, USDHKD and USDCNY, copied from our own tables. The model never
 * writes these numbers; a series with no stored data (VHSI has no free daily history) is left out rather than invented.
 */
import type { Market } from '../../core/calendar';
import { diffDays, type ISODate } from '../../core/dates';
import { hkDayOf, type NewsTapeItem } from '../../core/news';
import type { Db } from '../../db/client';
import { latestCloses, latestFxRates } from '../../db/news';
import { findInstrument } from '../../db/repos';

/** A series older than this is stale and is left out of the tape. */
const MAX_AGE_DAYS = 10;

interface IndexSeries {
  key: string;
  label: string;
  market: Market;
  symbol: string;
  /** Print the level (HSI, VIX); false prints only the day's change (SPY is an ETF: its price is not the index level). */
  level: boolean;
  /** Print the day's change in percent. */
  change: boolean;
}

const INDEXES: IndexSeries[] = [
  { key: 'spx', label: 'S&P 500', market: 'US', symbol: 'SPY', level: false, change: true },
  { key: 'hsi', label: 'HSI', market: 'HK', symbol: 'HSI', level: true, change: true },
  { key: 'vix', label: 'VIX', market: 'US', symbol: 'VIX', level: true, change: false },
  { key: 'vhsi', label: 'VHSI', market: 'HK', symbol: 'VHSI', level: true, change: false },
];

/** 26,512 for an index in the thousands, 17.2 for a vol index. */
export function levelText(x: number): string {
  return x >= 1000
    ? Math.round(x).toLocaleString('en-US')
    : x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

export async function buildTape(db: Db, now: Date): Promise<NewsTapeItem[]> {
  const today = hkDayOf(now);
  const fresh = (day: ISODate): boolean => diffDays(today, day) <= MAX_AGE_DAYS;
  const out: NewsTapeItem[] = [];

  const found = await Promise.all(
    INDEXES.map(async (s) => ({ s, inst: await findInstrument(db, s.market, s.symbol) })),
  );
  const closes = await latestCloses(
    db,
    found.flatMap((f) => (f.inst ? [f.inst.id] : [])),
  );
  for (const { s, inst } of found) {
    const c = inst ? closes.get(inst.id) : undefined;
    if (!c || !fresh(c.day)) continue;
    out.push({
      key: s.key,
      label: s.label,
      value: s.level ? levelText(c.close) : '',
      changePct: s.change && c.changePct !== null ? round1(c.changePct) : null,
      asOf: c.day,
    });
  }

  const fx = await latestFxRates(db, ['USDHKD', 'CNYHKD']);
  const usdhkd = fx.get('USDHKD');
  if (usdhkd && fresh(usdhkd.day))
    out.push({ key: 'usdhkd', label: 'USDHKD', value: usdhkd.rate.toFixed(2), changePct: null, asOf: usdhkd.day });
  // Yahoo has no daily history for the offshore yuan, so the tape shows the onshore rate implied by the two stored pairs
  // (HKD per USD over HKD per CNY), taken from the same day.
  const cnyhkd = fx.get('CNYHKD');
  if (usdhkd && cnyhkd && usdhkd.day === cnyhkd.day && cnyhkd.rate > 0 && fresh(usdhkd.day))
    out.push({
      key: 'usdcny',
      label: 'USDCNY',
      value: (usdhkd.rate / cnyhkd.rate).toFixed(2),
      changePct: null,
      asOf: usdhkd.day,
    });
  return out;
}

/** The tape as lines for the prompt: the model may reason from these numbers and may reuse them, nothing else. */
export function tapeLines(tape: readonly NewsTapeItem[]): string[] {
  return tape.map(
    (t) =>
      `- ${t.label}: ${[t.value, t.changePct === null ? '' : `${t.changePct > 0 ? '+' : ''}${t.changePct}% on the day`]
        .filter(Boolean)
        .join(', ')} (as of ${t.asOf})`,
  );
}
