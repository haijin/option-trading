import { defaultAsOf } from '../../cli/asof';
import { evaluateAlerts } from '../../core/alerts';
import type { Market } from '../../core/calendar';
import { diffDays, type ISODate } from '../../core/dates';
import {
  dataStatusFor,
  getPositionRow,
  lastCloses,
  listPositionsDetailed,
  listWatchlistAll,
  type PositionRow,
} from '../../db/app-repos';
import { loadPortfolio } from '../../db/history';
import { listLots, sellLot } from '../../db/lots';
import { latestMarks, markOpenPositions } from '../../db/marks';
import { closeManualPosition, openManualPosition } from '../../db/position-ops';
import { findInstrument, loadParams } from '../../db/repos';
import { importJournal } from '../../providers/csv/store';
import type {
  AlertView,
  Currency,
  JournalImportView,
  JournalSummaryView,
  LotSellInput,
  LotView,
  MarkRunView,
  PositionAddInput,
  PositionCloseInput,
  PositionsView,
  PositionView,
} from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest, notFound } from '../errors';
import { deploymentFor } from './portfolio';
import { regimeCaps } from './regime-cache';
import type { ScanService } from './scan-service';
import type { AppState } from './state';
import { parseMarketSymbol } from './watch-service';

export class PositionService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly scan: ScanService,
  ) {}

  private today(): ISODate {
    return this.deps.now().toISOString().slice(0, 10);
  }

  async list(): Promise<PositionsView> {
    const rows = await listPositionsDetailed(this.deps.db);
    const views = await this.toViews(rows);
    const open = views
      .filter((v) => v.status === 'open')
      .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.symbol.localeCompare(b.symbol));
    const closed = views.filter((v) => v.status !== 'open');
    const dep = await deploymentFor(this.deps, await regimeCaps(this.scan));
    const lots = await this.lots();
    return {
      open,
      closed,
      journal: journalSummary(closed),
      deployed: dep.deployed,
      marksAvailable: open.some((p) => p.mark !== null),
      lots,
    };
  }

  async toViews(rows: PositionRow[]): Promise<PositionView[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.instrument.id))];
    const closes = await lastCloses(this.deps.db, ids);
    const today = this.today();
    const status = await dataStatusFor(this.deps.db, ids, today);
    const marks = await latestMarks(
      this.deps.db,
      rows.filter((r) => r.status === 'open').map((r) => r.id),
    );
    const pf = await loadPortfolio(this.deps.db, defaultAsOf(this.deps.now()));
    const watch = new Map((await listWatchlistAll(this.deps.db)).map((w) => [w.id, w.active]));
    return rows.map((r) => {
      const inst = r.instrument;
      const spot = closes.get(inst.id)?.close ?? null;
      const dte = diffDays(r.expiry, today);
      const distancePct = spot !== null && spot > 0 ? ((spot - r.strike) / spot) * 100 : null;
      const m = marks.get(r.id) ?? null;
      // A mark older than a week is shown but not used for the mark-based rules: stale P&L must not look current.
      const freshMark = m !== null && diffDays(today, m.day) <= 7 ? m : null;
      const alerts: AlertView[] =
        r.status === 'open'
          ? evaluateAlerts({
              strike: r.strike,
              expiry: r.expiry,
              openPrice: r.openPrice,
              openDate: r.openDate,
              today,
              spot,
              mark: freshMark?.mark ?? null,
              nextEarnings: status.get(inst.id)?.nextEarnings ?? null,
            })
          : [];
      const fx = pf.fxToBase(inst.currency as Currency);
      const collateral = r.strike * r.multiplier * r.quantity;
      return {
        id: r.id,
        symbol: inst.symbol,
        market: inst.market,
        name: inst.name,
        currency: inst.currency,
        strike: r.strike,
        expiry: r.expiry,
        dte,
        quantity: r.quantity,
        multiplier: r.multiplier,
        openDate: r.openDate,
        openPrice: r.openPrice,
        credit: r.openPrice * r.multiplier * r.quantity,
        collateral,
        collateralBase: fx === null ? null : collateral * fx,
        status: r.status,
        closeDate: r.closeDate,
        closePrice: r.closePrice,
        realizedPnl: r.realizedPnl,
        spot,
        distancePct,
        alerts,
        mark:
          r.status === 'open' && m
            ? {
                day: m.day,
                price: m.mark,
                unrealizedPnl: m.unrealizedPnl,
                pctCaptured: m.pctCaptured,
                delta: m.delta,
                tier: m.tier,
              }
            : null,
        source: r.source,
        watching: watch.get(inst.id) ?? false,
      };
    });
  }

  async add(input: PositionAddInput): Promise<PositionView> {
    const { market, symbol } = parseMarketSymbol(input.symbol, input.market);
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst)
      throw badRequest('unknown_stock', `${market}:${symbol} is not in the database: add it to the watchlist first`);
    const id = await openManualPosition(this.deps.db, {
      instrument: inst,
      strike: input.strike,
      expiry: input.expiry,
      contracts: input.contracts,
      price: input.price,
      date: input.date ?? this.today(),
      ...(input.fees !== undefined ? { fees: input.fees } : {}),
      ...(input.spot !== undefined ? { spot: input.spot } : {}),
    });
    this.state.bump();
    return this.one(id);
  }

  async close(id: number, input: PositionCloseInput): Promise<PositionView> {
    if (!(await getPositionRow(this.deps.db, id))) throw notFound(`no position with id ${id}`);
    await closeManualPosition(this.deps.db, {
      id,
      kind: input.kind,
      today: this.today(),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.date ? { date: input.date } : {}),
      ...(input.fees !== undefined ? { fees: input.fees } : {}),
      ...(input.underlyingClose !== undefined ? { underlyingClose: input.underlyingClose } : {}),
    });
    this.state.bump();
    return this.one(id);
  }

  private async one(id: number): Promise<PositionView> {
    const row = await getPositionRow(this.deps.db, id);
    if (!row) throw notFound(`no position with id ${id}`);
    return (await this.toViews([row]))[0] as PositionView;
  }

  /** Marks every open put now (the same job the scheduler runs) and returns what it found, alerts included. */
  async runMarks(asOf?: ISODate): Promise<MarkRunView> {
    const day = asOf ?? defaultAsOf(this.deps.now());
    const { params } = await loadParams(this.deps.db);
    const res = await markOpenPositions(this.deps.db, { asOf: day, params, knownThrough: this.today() });
    const rows = await listPositionsDetailed(this.deps.db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    this.state.bump();
    return {
      asOf: day,
      marked: res.marked.length,
      skipped: res.skipped.map((s) => ({ symbol: s.symbol, reason: s.reason })),
      alerts: res.marked.flatMap((m) => {
        const p = byId.get(m.positionId);
        return m.alerts.map((a) => ({
          symbol: m.symbol,
          strike: p?.strike ?? 0,
          expiry: p?.expiry ?? '',
          code: a.code,
          level: a.level,
          text: a.text,
        }));
      }),
    };
  }

  async lots(status?: 'open' | 'sold'): Promise<LotView[]> {
    const rows = await listLots(this.deps.db, status ? { status } : {});
    const closes = await lastCloses(this.deps.db, [...new Set(rows.map((l) => l.instrument.id))]);
    return rows.map((l) => {
      const spot = closes.get(l.instrument.id)?.close ?? null;
      return {
        id: l.id,
        symbol: l.instrument.symbol,
        market: l.instrument.market,
        name: l.instrument.name,
        currency: l.instrument.currency as Currency,
        shares: l.shares,
        costBasis: l.costBasis,
        effectiveCost: l.effectiveCost,
        openDate: l.openDate,
        status: l.status,
        closeDate: l.closeDate,
        closePrice: l.closePrice,
        realizedPnl: l.realizedPnl,
        spot,
        unrealizedPnl: l.status === 'open' && spot !== null ? (spot - l.costBasis) * l.shares : null,
      };
    });
  }

  async sellLot(id: number, input: LotSellInput): Promise<LotView> {
    const lot = (await listLots(this.deps.db)).find((l) => l.id === id);
    if (!lot) throw notFound('no stock lot with id ' + id);
    await sellLot(this.deps.db, id, {
      price: input.price,
      date: input.date ?? this.today(),
      ...(input.fees !== undefined ? { fees: input.fees } : {}),
    });
    this.state.bump();
    return (await this.lots()).find((l) => l.id === id) as LotView;
  }

  async importJournalCsv(csv: string): Promise<JournalImportView> {
    const r = await importJournal(this.deps.db, csv, this.deps.now());
    if (r.ok) this.state.bump();
    return {
      ok: r.ok,
      imported: r.imported,
      skippedExisting: r.skippedExisting,
      quotesWritten: r.quotesWritten,
      totals: r.totals,
      warnings: r.warnings,
      errors: r.errors,
    };
  }
}

export function journalSummary(closed: PositionView[]): JournalSummaryView {
  const realised: Partial<Record<Currency, number>> = {};
  let wins = 0;
  let trades = 0;
  for (const p of closed) {
    if (p.realizedPnl === null) continue;
    trades++;
    if (p.realizedPnl > 0) wins++;
    realised[p.currency] = (realised[p.currency] ?? 0) + p.realizedPnl;
  }
  for (const k of Object.keys(realised) as Currency[]) realised[k] = Math.round((realised[k] as number) * 100) / 100;
  return { trades, wins, winRatePct: trades > 0 ? (wins / trades) * 100 : null, realised };
}

export type { Market };
