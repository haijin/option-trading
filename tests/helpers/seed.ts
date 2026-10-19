import { and, eq } from 'drizzle-orm';
import type { Market } from '../../src/core/calendar';
import type { DailyBar, Instrument } from '../../src/core/types';
import type { Db } from '../../src/db/client';
import { findInstrument, upsertInstrument } from '../../src/db/repos';
import { skillRuns } from '../../src/db/schema';

export async function seedInstrument(
  db: Db,
  market: Market,
  symbol: string,
  extra: Partial<Parameters<typeof upsertInstrument>[1]> = {},
): Promise<Instrument> {
  return upsertInstrument(db, { market, symbol, ...extra });
}

export async function indexInstrument(db: Db, market: Market, symbol: string): Promise<Instrument> {
  const i = await findInstrument(db, market, symbol);
  if (!i) throw new Error(`index instrument ${market}:${symbol} not seeded`);
  return i;
}

export async function seedSkillRun(db: Db, instrumentId: number, asOf: string, skillId = 'test.skill'): Promise<void> {
  await db.insert(skillRuns).values({
    instrumentId,
    asOf,
    skillId,
    skillVersion: '1.0.0',
    paramsHash: 'h',
    verdict: 'NA',
    reasons: [],
    payload: {},
    dataTier: 'real',
  });
}

export async function skillRunDates(db: Db, instrumentId: number): Promise<string[]> {
  const rows = await db
    .select({ d: skillRuns.asOf })
    .from(skillRuns)
    .where(and(eq(skillRuns.instrumentId, instrumentId)))
    .orderBy(skillRuns.asOf);
  return rows.map((r) => r.d);
}

export function bar(day: string, close: number, source = 'yahoo', extra: Partial<DailyBar> = {}): DailyBar {
  return { day, open: close, high: close + 1, low: close - 1, close, adjClose: close, volume: 1000, source, ...extra };
}
