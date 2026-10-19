import { sql } from 'drizzle-orm';
import { INDEX_SPECS } from '../core/benchmarks';
import { calendarRows, type Market } from '../core/calendar';
import type { DbOrTx } from './client';
import { exchangeCalendar, instruments } from './schema';

/** Idempotent reference data: exchange calendars (from the static tables) and the index/vol-index instruments. */
export async function seedReferenceData(db: DbOrTx): Promise<void> {
  for (const market of ['US', 'HK'] as Market[]) {
    const rows = calendarRows(market).map((r) => ({ market, day: r.day, isTradingDay: r.isTradingDay, note: r.note }));
    for (let i = 0; i < rows.length; i += 1000) {
      await db
        .insert(exchangeCalendar)
        .values(rows.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: [exchangeCalendar.market, exchangeCalendar.day],
          set: { isTradingDay: sql`excluded.is_trading_day`, note: sql`excluded.note` },
        });
    }
  }
  for (const spec of INDEX_SPECS) {
    await db
      .insert(instruments)
      .values({
        market: spec.market,
        symbol: spec.symbol,
        name: spec.name,
        currency: spec.currency,
        sector: 'INDEX',
        hasListedOptions: false,
        boardLot: 1,
        providerSymbols: spec.yahoo ? { yahoo: spec.yahoo } : {},
      })
      .onConflictDoNothing();
  }
}
