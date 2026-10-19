/**
 * The wheel: shares received when a put is assigned (docs/06 Phase 3). The app never places orders; these rows record
 * what the user did.
 *
 * Accounting: closing an assigned put books its realised P&L as (premium - (strike - underlying close at assignment)),
 * so the shares start at the underlying close and a later sale books (sale price - that basis). Adding both together
 * gives the true result of the wheel cycle without counting the assignment loss twice. The effective cost per share
 * (strike less the premium, the number a trader compares a covered-call strike with) is derived for display only.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { ISODate } from '../core/dates';
import type { Instrument } from '../core/types';
import { UserError } from '../core/util';
import type { DbOrTx } from './client';
import { toInstrument } from './repos';
import { instruments, positions, stockLots } from './schema';

export async function openLotForAssignment(
  db: DbOrTx,
  p: { positionId: number; instrumentId: number; shares: number; underlyingClose: number; date: ISODate },
): Promise<number | null> {
  const [r] = await db
    .insert(stockLots)
    .values({
      instrumentId: p.instrumentId,
      positionId: p.positionId,
      shares: p.shares,
      costBasis: p.underlyingClose.toFixed(6),
      openDate: p.date,
    })
    .onConflictDoNothing()
    .returning({ id: stockLots.id });
  return r?.id ?? null;
}

export interface LotRow {
  id: number;
  instrument: Instrument;
  positionId: number | null;
  shares: number;
  /** Booking basis: the underlying close at assignment. */
  costBasis: number;
  /** Strike less net premium per share; null for a lot not tied to an assigned put. */
  effectiveCost: number | null;
  openDate: ISODate;
  status: 'open' | 'sold';
  closeDate: ISODate | null;
  closePrice: number | null;
  realizedPnl: number | null;
}

export async function listLots(db: DbOrTx, opts: { status?: 'open' | 'sold' } = {}): Promise<LotRow[]> {
  const rows = await db
    .select({ l: stockLots, i: instruments, p: positions })
    .from(stockLots)
    .innerJoin(instruments, eq(instruments.id, stockLots.instrumentId))
    .leftJoin(positions, eq(positions.id, stockLots.positionId))
    .where(opts.status ? eq(stockLots.status, opts.status) : undefined)
    .orderBy(desc(stockLots.openDate), desc(stockLots.id));
  return rows.map(({ l, i, p }) => {
    const effective =
      p === null
        ? null
        : Number(p.strike) - (Number(p.openPrice) * p.multiplier * p.quantity - Number(p.openFees)) / l.shares;
    return {
      id: l.id,
      instrument: toInstrument(i),
      positionId: l.positionId,
      shares: l.shares,
      costBasis: Number(l.costBasis),
      effectiveCost: effective === null ? null : Math.round(effective * 1e6) / 1e6,
      openDate: l.openDate,
      status: l.status as 'open' | 'sold',
      closeDate: l.closeDate,
      closePrice: l.closePrice === null ? null : Number(l.closePrice),
      realizedPnl: l.realizedPnl === null ? null : Number(l.realizedPnl),
    };
  });
}

/** Records the sale of a lot (shares sold at `price` per share). Realised P&L = (price - basis) x shares - fees. */
export async function sellLot(
  db: DbOrTx,
  id: number,
  s: { price: number; date: ISODate; fees?: number },
): Promise<{ realizedPnl: number }> {
  const [l] = await db.select().from(stockLots).where(eq(stockLots.id, id));
  if (!l) throw new UserError(`no stock lot with id ${id}`);
  if (l.status !== 'open') throw new UserError(`lot ${id} is already sold`);
  if (!(s.price > 0)) throw new UserError('sale price must be a positive number');
  if (s.fees !== undefined && (!Number.isFinite(s.fees) || s.fees < 0))
    throw new UserError('fees must be zero or more');
  if (s.date < l.openDate) throw new UserError('the sale date is before the lot was opened');
  const pnl = Math.round(((s.price - Number(l.costBasis)) * l.shares - (s.fees ?? 0)) * 100) / 100;
  const updated = await db
    .update(stockLots)
    .set({ status: 'sold', closeDate: s.date, closePrice: s.price.toFixed(6), realizedPnl: pnl.toFixed(6) })
    .where(and(eq(stockLots.id, id), eq(stockLots.status, 'open')))
    .returning({ id: stockLots.id });
  // Two taps or two tabs can both pass the check above; only the first update may report a sale.
  if (updated.length === 0) throw new UserError(`lot ${id} is already sold`);
  return { realizedPnl: pnl };
}
