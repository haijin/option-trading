import { and, eq, gte, inArray } from 'drizzle-orm';
import type { ISODate } from '../core/dates';
import type { DbOrTx } from './client';
import { instruments, skillRuns } from './schema';

/**
 * The single cache-invalidation helper (docs/02 section 2). Every function that writes bars, fundamentals, corporate
 * events, FX, option quotes or IV history calls it, with the earliest date whose stored inputs changed (adjusted
 * closes restate all history on a dividend, so that is not "today"). Deletes cached skill results with as_of >= from.
 *
 * Index and vol-index instruments (sector INDEX) feed every name of their market through S0 and S2 relative strength,
 * so a change to them invalidates the whole market, not just their own rows.
 */
export async function invalidateSkillRuns(db: DbOrTx, instrumentId: number, fromDate: ISODate): Promise<number> {
  const [inst] = await db
    .select({ market: instruments.market, sector: instruments.sector })
    .from(instruments)
    .where(eq(instruments.id, instrumentId));
  if (!inst) return 0;
  const scope =
    inst.sector === 'INDEX'
      ? inArray(
          skillRuns.instrumentId,
          db.select({ id: instruments.id }).from(instruments).where(eq(instruments.market, inst.market)),
        )
      : eq(skillRuns.instrumentId, instrumentId);
  const deleted = await db
    .delete(skillRuns)
    .where(and(scope, gte(skillRuns.asOf, fromDate)))
    .returning({ id: skillRuns.id });
  return deleted.length;
}

/** For inputs shared by every instrument (FX rates). */
export async function invalidateAllSkillRuns(db: DbOrTx, fromDate: ISODate): Promise<number> {
  const deleted = await db.delete(skillRuns).where(gte(skillRuns.asOf, fromDate)).returning({ id: skillRuns.id });
  return deleted.length;
}
