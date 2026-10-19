/**
 * Recording and closing a put by hand. One implementation for the CLI (`positions add|close`) and the web app, so the
 * validation rules and the P&L booking cannot drift apart. The app never places orders: these only record what the user did.
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import { isExpiryDay } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { Instrument } from '../core/types';
import { UserError } from '../core/util';
import type { DbOrTx } from './client';
import { openLotForAssignment } from './lots';
import { closePosition, insertPosition } from './repos';
import { positions, priceBars } from './schema';

export interface ManualOpenInput {
  instrument: Instrument;
  strike: number;
  expiry: ISODate;
  contracts: number;
  /** Premium per share received. */
  price: number;
  date: ISODate;
  fees?: number;
  spot?: number | null;
}

export async function openManualPosition(db: DbOrTx, i: ManualOpenInput): Promise<number> {
  if (!(i.strike > 0)) throw new UserError('strike must be a positive number');
  if (!Number.isInteger(i.contracts) || i.contracts <= 0)
    throw new UserError('contracts must be a positive whole number');
  if (!(i.price > 0)) throw new UserError('premium must be a positive number');
  if (i.fees !== undefined && (!Number.isFinite(i.fees) || i.fees < 0))
    throw new UserError('fees must be zero or more');
  if (!isExpiryDay(i.instrument.market, i.expiry)) {
    throw new UserError(
      `${i.expiry} is not an option expiry day on the ${i.instrument.market} calendar (HK: monthly, business day before the last business day; US: Fridays)`,
    );
  }
  if (i.expiry < i.date) throw new UserError('expiry is before the fill date');
  const id = await insertPosition(db, {
    instrumentId: i.instrument.id,
    strike: i.strike,
    expiry: i.expiry,
    multiplier: i.instrument.multiplier,
    quantity: i.contracts,
    openDate: i.date,
    openPrice: i.price,
    openFees: i.fees ?? 0,
    spotAtOpen: i.spot ?? null,
    source: 'manual',
  });
  if (id === null) throw new UserError('this fill is already recorded');
  return id;
}

export type CloseKind = 'bought_back' | 'expired' | 'assigned';

export interface ManualCloseInput {
  id: number;
  kind: CloseKind;
  price?: number;
  date?: ISODate;
  fees?: number;
  underlyingClose?: number;
  today: ISODate;
}

export interface ManualCloseResult {
  status: 'closed' | 'expired' | 'assigned';
  date: ISODate;
  realizedPnl: number;
  basis: string | null;
  instrumentId: number;
}

export async function closeManualPosition(db: DbOrTx, c: ManualCloseInput): Promise<ManualCloseResult> {
  const [p] = await db.select().from(positions).where(eq(positions.id, c.id));
  if (!p) throw new UserError(`no position with id ${c.id}`);
  if (p.status !== 'open') throw new UserError(`position ${c.id} is already ${p.status}`);
  let status: ManualCloseResult['status'] = 'closed';
  let price: number;
  let date = c.date ?? c.today;
  let basis: string | null = null;
  let assignedAt: number | null = null;
  if (c.kind === 'expired') {
    status = 'expired';
    price = 0;
    date = c.date ?? p.expiry;
  } else if (c.kind === 'assigned') {
    status = 'assigned';
    date = c.date ?? p.expiry;
    let u = c.underlyingClose ?? null;
    if (u === null) {
      const [bar] = await db
        .select({ c: priceBars.close })
        .from(priceBars)
        .where(and(eq(priceBars.instrumentId, p.instrumentId), lte(priceBars.day, date)))
        .orderBy(desc(priceBars.day))
        .limit(1);
      u = bar ? Number(bar.c) : null;
    }
    if (u === null) throw new UserError('assigned needs the underlying close (no stored bar close to fall back on)');
    price = Math.max(0, Number(p.strike) - u);
    basis = 'mtm_at_assignment';
    assignedAt = u;
  } else {
    if (c.price === undefined || !(c.price >= 0)) throw new UserError('enter the buy-back premium per share');
    price = c.price;
  }
  const finish = async (tx: DbOrTx) => {
    const closed = await closePosition(tx, c.id, {
      closeDate: date,
      closePrice: price,
      closeFees: c.fees ?? 0,
      status,
      ...(basis ? { pnlBasis: basis } : {}),
    });
    // The wheel: an assigned put leaves a stock lot so the shares are tracked (and sold) instead of being a note.
    if (status === 'assigned' && assignedAt !== null)
      await openLotForAssignment(tx, {
        positionId: p.id,
        instrumentId: p.instrumentId,
        shares: p.quantity * p.multiplier,
        underlyingClose: assignedAt,
        date,
      });
    return closed;
  };
  // One transaction: a put must never end up "assigned" with no lot (a retry would then refuse as already assigned).
  const withTx = db as DbOrTx & { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
  const r = withTx.transaction ? await withTx.transaction(finish) : await finish(db);
  return { status, date, realizedPnl: r?.realizedPnl ?? 0, basis, instrumentId: p.instrumentId };
}
