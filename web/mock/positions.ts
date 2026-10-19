import type { AlertView, JournalSummaryView, PositionsView, PositionView } from '../../src/server/api-types';
import type { PositionRec } from './model';
import { HK_LOTS } from './seed-ref';
import { deployView, findRow, nextEarnings, pnlOf, store, toBase } from './state';
import { directoryName, marketCurrency, parseSymbol } from './symbols';
import { ASOF, conflict, daysBetween, invalid, notFound, round } from './util';
import { Body } from './validate';

export function alertsOf(rec: PositionRec, spot: number | null, dte: number): AlertView[] {
  if (rec.status !== 'open') return [];
  const out: AlertView[] = [];
  const distance = spot === null ? null : ((spot - rec.strike) / spot) * 100;
  if (spot !== null && distance !== null) {
    if (spot < rec.strike)
      out.push({ level: 'fail', code: 'itm', text: `In the money: ${spot} is below the ${rec.strike} strike.` });
    else if (distance < 5)
      out.push({
        level: 'warn',
        code: 'near_strike',
        text: `Only ${distance.toFixed(1)}% above the ${rec.strike} strike.`,
      });
  }
  const er = nextEarnings(rec.market, rec.symbol, findRow(rec.market, rec.symbol)?.profile ?? null);
  if (er && er.date > ASOF && er.date <= rec.expiry) {
    out.push({
      level: 'warn',
      code: 'earnings_before_expiry',
      text: `Results on ${er.date} fall before the ${rec.expiry} expiry.`,
    });
  }
  if (dte <= 21) out.push({ level: 'warn', code: 'dte21', text: `${dte} DTE: close or roll.` });
  return out;
}

export function positionView(rec: PositionRec): PositionView {
  const row = findRow(rec.market, rec.symbol);
  const spot = row?.profile?.spot ?? rec.spotHint;
  const dte = Math.max(0, daysBetween(ASOF, rec.expiry));
  const collateral = rec.strike * rec.multiplier * rec.quantity;
  return {
    id: rec.id,
    symbol: rec.symbol,
    market: rec.market,
    name: row?.name ?? directoryName(rec.market, rec.symbol),
    currency: marketCurrency(rec.market),
    strike: rec.strike,
    expiry: rec.expiry,
    dte,
    quantity: rec.quantity,
    multiplier: rec.multiplier,
    openDate: rec.openDate,
    openPrice: rec.openPrice,
    credit: round(rec.openPrice * rec.multiplier * rec.quantity, 2),
    collateral: round(collateral, 2),
    collateralBase: round(toBase(collateral, marketCurrency(rec.market)), 2),
    status: rec.status,
    closeDate: rec.closeDate,
    closePrice: rec.closePrice,
    realizedPnl: rec.realizedPnl,
    spot,
    distancePct: spot === null ? null : round(((spot - rec.strike) / spot) * 100, 2),
    alerts: alertsOf(rec, spot, dte),
    mark: null,
    source: rec.source,
    watching: row?.active ?? false,
  };
}

export function journalSummary(): JournalSummaryView {
  const done = store.positions.filter((p) => p.status !== 'open');
  const base = store.journalBase;
  const trades = base.trades + done.length;
  const wins = base.wins + done.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const sum = (m: 'US' | 'HK') => done.filter((p) => p.market === m).reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  return {
    trades,
    wins,
    winRatePct: trades > 0 ? round((wins / trades) * 100, 1) : null,
    realised: {
      HKD: round((base.realised.HKD ?? 0) + sum('HK'), 2),
      USD: round((base.realised.USD ?? 0) + sum('US'), 2),
    },
  };
}

export function buildPositions(): PositionsView {
  const open = store.positions
    .filter((p) => p.status === 'open')
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.symbol.localeCompare(b.symbol));
  const closed = store.positions
    .filter((p) => p.status !== 'open')
    .sort((a, b) => (b.closeDate ?? '').localeCompare(a.closeDate ?? '') || b.id - a.id)
    .slice(0, 20);
  return {
    open: open.map(positionView),
    closed: closed.map(positionView),
    journal: journalSummary(),
    deployed: { US: deployView('US'), HK: deployView('HK') },
    marksAvailable: false,
    lots: [],
  };
}

export function addPosition(raw: unknown): PositionView {
  const b = Body.from(raw);
  const parsed = parseSymbol(b.string('symbol'), b.optOneOf('market', ['US', 'HK'] as const) ?? 'auto');
  if (!parsed.ok) throw invalid(parsed.error);
  const strike = b.number('strike', { positive: true });
  const expiry = b.date('expiry');
  const quantity = b.number('contracts', { int: true, positive: true, max: 1000 });
  const openPrice = b.number('price', { positive: true });
  const openDate = b.optDate('date') ?? ASOF;
  const openFees = b.optNumber('fees', { min: 0 }) ?? 0;
  const spotHint = b.optNumber('spot', { positive: true }) ?? null;
  if (expiry <= openDate) throw invalid(`Field "expiry" (${expiry}) must be after the open date (${openDate}).`);
  if (expiry <= ASOF)
    throw invalid(
      `Field "expiry" (${expiry}) is already past the last stored session (${ASOF}): use the journal import for finished trades.`,
    );
  if (openPrice >= strike) throw invalid('Field "price" must be below the strike: it is the premium per share.');
  const row = findRow(parsed.market, parsed.symbol);
  const lot = parsed.market === 'US' ? 100 : (row?.boardLot ?? HK_LOTS[parsed.symbol]?.[0]);
  if (lot === undefined)
    throw invalid(`No board lot is known for HK:${parsed.symbol}: add it to the watchlist with a board lot first.`);
  const rec: PositionRec = {
    id: store.nextPositionId++,
    symbol: parsed.symbol,
    market: parsed.market,
    strike,
    expiry,
    quantity,
    multiplier: lot,
    openDate,
    openPrice,
    openFees,
    status: 'open',
    closeDate: null,
    closePrice: null,
    closeFees: 0,
    realizedPnl: null,
    source: 'manual',
    spotHint,
  };
  store.positions.push(rec);
  return positionView(rec);
}

export function closePosition(id: number, raw: unknown): PositionView {
  const rec = store.positions.find((p) => p.id === id);
  if (!rec) throw notFound(`Position ${id} does not exist.`);
  if (rec.status !== 'open') throw conflict('position_not_open', `Position ${id} is already ${rec.status}.`);
  const b = Body.from(raw);
  const kind = b.oneOf('kind', ['bought_back', 'expired', 'assigned'] as const);
  const date = b.optDate('date') ?? ASOF;
  if (date < rec.openDate) throw invalid(`Field "date" (${date}) is before the open date (${rec.openDate}).`);
  const fees = b.optNumber('fees', { min: 0 }) ?? 0;
  if (kind === 'bought_back') {
    if (!b.has('price'))
      throw invalid('Field "price" is required when kind is bought_back: the buy-back premium per share.');
    rec.closePrice = b.number('price', { min: 0 });
    rec.status = 'closed';
  } else if (kind === 'expired') {
    rec.closePrice = 0;
    rec.status = 'expired';
  } else {
    if (!b.has('underlyingClose'))
      throw invalid(
        'Field "underlyingClose" is required when kind is assigned: the underlying close on the assignment date.',
      );
    const underlying = b.number('underlyingClose', { positive: true });
    // Booked as if the shares were sold at that close: the loss per share is the intrinsic value.
    rec.closePrice = round(Math.max(0, rec.strike - underlying), 4);
    rec.status = 'assigned';
  }
  rec.closeDate = date;
  rec.closeFees = fees;
  rec.realizedPnl = pnlOf(rec);
  return positionView(rec);
}
