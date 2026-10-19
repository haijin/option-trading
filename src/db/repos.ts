/** Reads and non-data writes (instruments, watchlist, settings, positions, job log). Data writers live in writers.ts. */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { BENCHMARK_SYMBOL } from '../core/benchmarks';
import type { Market } from '../core/calendar';
import { normaliseTiers } from '../core/governor';
import { pnlCents } from '../core/money';
import { paramsHash, resolveParams, type StrategyParams } from '../core/params';
import { currencyOf } from '../core/symbols';
import type {
  Currency,
  GovernorSettings,
  Instrument,
  OpenPosition,
  ReportingFrequency,
  SolvencyModel,
} from '../core/types';
import { num } from '../core/util';
import type { DbOrTx } from './client';
import { instruments, jobRuns, portfolioSettings, positions, priceBars, strategyParams, watchlist } from './schema';

type InstrumentRow = typeof instruments.$inferSelect;

export function toInstrument(r: InstrumentRow): Instrument {
  return {
    id: r.id,
    market: r.market,
    symbol: r.symbol,
    name: r.name,
    currency: r.currency as Currency,
    sector: r.sector,
    industry: r.industry,
    solvencyModel: r.solvencyModel as SolvencyModel,
    reportingFrequency: r.reportingFrequency as ReportingFrequency,
    benchmarkInstrumentId: r.benchmarkInstrumentId,
    multiplier: r.boardLot,
    hasListedOptions: r.hasListedOptions,
    providerSymbols: r.providerSymbols,
  };
}

export async function findInstrument(db: DbOrTx, market: Market, symbol: string): Promise<Instrument | null> {
  const [r] = await db
    .select()
    .from(instruments)
    .where(and(eq(instruments.market, market), eq(instruments.symbol, symbol)));
  return r ? toInstrument(r) : null;
}

export async function getInstrument(db: DbOrTx, id: number): Promise<Instrument | null> {
  const [r] = await db.select().from(instruments).where(eq(instruments.id, id));
  return r ? toInstrument(r) : null;
}

export async function benchmarkFor(db: DbOrTx, market: Market): Promise<Instrument | null> {
  return findInstrument(db, market, BENCHMARK_SYMBOL[market]);
}

export interface InstrumentInput {
  market: Market;
  symbol: string;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  solvencyModel?: SolvencyModel;
  reportingFrequency?: ReportingFrequency;
  boardLot?: number;
  hasListedOptions?: boolean;
  providerSymbols?: Record<string, unknown>;
}

/** Creates or updates an instrument; only fields that are provided are changed on update. Sets the market benchmark. */
export async function upsertInstrument(db: DbOrTx, input: InstrumentInput): Promise<Instrument> {
  const bench = await benchmarkFor(db, input.market);
  const existing = await findInstrument(db, input.market, input.symbol);
  const patch: Partial<typeof instruments.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.sector !== undefined) patch.sector = input.sector;
  if (input.industry !== undefined) patch.industry = input.industry;
  if (input.solvencyModel !== undefined) patch.solvencyModel = input.solvencyModel;
  if (input.reportingFrequency !== undefined) patch.reportingFrequency = input.reportingFrequency;
  if (input.boardLot !== undefined) patch.boardLot = input.boardLot;
  if (input.hasListedOptions !== undefined) patch.hasListedOptions = input.hasListedOptions;
  if (input.providerSymbols !== undefined) patch.providerSymbols = input.providerSymbols;
  if (existing) {
    if (Object.keys(patch).length > 0) await db.update(instruments).set(patch).where(eq(instruments.id, existing.id));
    return (await getInstrument(db, existing.id)) as Instrument;
  }
  const [row] = await db
    .insert(instruments)
    .values({
      market: input.market,
      symbol: input.symbol,
      currency: currencyOf(input.market),
      reportingFrequency: input.market === 'HK' ? 'semiannual' : 'quarterly',
      boardLot: input.market === 'US' ? 100 : 100,
      benchmarkInstrumentId: bench?.id ?? null,
      ...patch,
    })
    .returning();
  return toInstrument(row as InstrumentRow);
}

export interface WatchlistEntry extends Instrument {
  watchlistId: number;
  conviction: number | null;
  maxCollateralPct: number | null;
  notes: string | null;
  active: boolean;
}

export async function addToWatchlist(
  db: DbOrTx,
  instrumentId: number,
  opts: { notes?: string | null; conviction?: number | null; maxCollateralPct?: number | null } = {},
): Promise<void> {
  await db
    .insert(watchlist)
    .values({
      instrumentId,
      notes: opts.notes ?? null,
      conviction: opts.conviction ?? null,
      maxCollateralPct:
        opts.maxCollateralPct === undefined || opts.maxCollateralPct === null ? null : String(opts.maxCollateralPct),
    })
    .onConflictDoUpdate({
      target: watchlist.instrumentId,
      set: {
        active: true,
        ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
        ...(opts.conviction !== undefined ? { conviction: opts.conviction } : {}),
      },
    });
}

export async function removeFromWatchlist(db: DbOrTx, instrumentId: number): Promise<boolean> {
  const res = await db
    .update(watchlist)
    .set({ active: false })
    .where(eq(watchlist.instrumentId, instrumentId))
    .returning({ id: watchlist.id });
  return res.length > 0;
}

export async function listWatchlist(db: DbOrTx, opts: { activeOnly?: boolean } = {}): Promise<WatchlistEntry[]> {
  const rows = await db
    .select({ i: instruments, w: watchlist })
    .from(watchlist)
    .innerJoin(instruments, eq(instruments.id, watchlist.instrumentId))
    .where(opts.activeOnly === false ? undefined : eq(watchlist.active, true))
    .orderBy(asc(instruments.market), asc(instruments.symbol));
  return rows.map(({ i, w }) => ({
    ...toInstrument(i),
    watchlistId: w.id,
    conviction: w.conviction,
    maxCollateralPct: num(w.maxCollateralPct),
    notes: w.notes,
    active: w.active,
  }));
}

export async function listIndexInstruments(db: DbOrTx): Promise<Instrument[]> {
  const rows = await db.select().from(instruments).where(eq(instruments.sector, 'INDEX'));
  return rows.map(toInstrument);
}

// ---------------------------------------------------------------- settings
export interface Settings {
  baseCurrency: Currency;
  equity: number | null;
  /** Drawdown governor (trade-skills T3); the defaults leave sizing unchanged. */
  governor: GovernorSettings;
}

export interface SettingsPatchInput {
  equity?: number;
  baseCurrency?: Currency;
  governor?: Partial<GovernorSettings>;
}

export async function getSettings(db: DbOrTx): Promise<Settings> {
  const [r] = await db.select().from(portfolioSettings).where(eq(portfolioSettings.id, 1));
  if (!r) throw new Error('portfolio_settings row missing: run `pnpm db:migrate`');
  return {
    baseCurrency: r.baseCurrency as Currency,
    equity: num(r.equity),
    governor: {
      dailyLossLimit: num(r.dailyLossLimit),
      consecutiveLossHalt: r.consecutiveLossHalt,
      degearTiers: normaliseTiers(Array.isArray(r.degearTiers) ? r.degearTiers : []),
    },
  };
}

export async function setSettings(db: DbOrTx, patch: SettingsPatchInput): Promise<Settings> {
  const set: Partial<typeof portfolioSettings.$inferInsert> = { updatedAt: new Date() };
  if (patch.equity !== undefined) set.equity = patch.equity.toFixed(2);
  if (patch.baseCurrency !== undefined) set.baseCurrency = patch.baseCurrency;
  const g = patch.governor;
  if (g) {
    if (g.dailyLossLimit !== undefined)
      set.dailyLossLimit = g.dailyLossLimit === null ? null : g.dailyLossLimit.toFixed(2);
    if (g.consecutiveLossHalt !== undefined) set.consecutiveLossHalt = g.consecutiveLossHalt;
    if (g.degearTiers !== undefined) set.degearTiers = normaliseTiers(g.degearTiers);
  }
  await db.update(portfolioSettings).set(set).where(eq(portfolioSettings.id, 1));
  return getSettings(db);
}

// --------------------------------------------------------------- positions
export async function listOpenPositions(db: DbOrTx): Promise<(OpenPosition & { positionId: number })[]> {
  const rows = await db
    .select({ p: positions, i: instruments })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .where(eq(positions.status, 'open'));
  return rows.map(({ p, i }) => ({
    positionId: p.id,
    instrumentId: i.id,
    symbol: i.symbol,
    market: i.market,
    sector: i.sector,
    currency: i.currency as Currency,
    strike: Number(p.strike),
    multiplier: p.multiplier,
    quantity: p.quantity,
    expiry: p.expiry,
  }));
}

export interface NewPosition {
  instrumentId: number;
  strike: number;
  expiry: string;
  multiplier: number;
  quantity: number;
  openDate: string;
  openPrice: number;
  openFees?: number;
  spotAtOpen?: number | null;
  notes?: string | null;
  source?: 'manual' | 'journal_import';
  status?: 'open' | 'closed' | 'rolled' | 'assigned' | 'expired';
  closeDate?: string | null;
  closePrice?: number | null;
  closeFees?: number | null;
  realizedPnl?: number | null;
  pnlBasis?: string | null;
  importKey?: string | null;
  flags?: string[];
  contractId?: number | null;
}

export async function insertPosition(db: DbOrTx, p: NewPosition): Promise<number | null> {
  const rows = await db
    .insert(positions)
    .values({
      instrumentId: p.instrumentId,
      contractId: p.contractId ?? null,
      right: 'P',
      strike: p.strike.toFixed(6),
      expiry: p.expiry,
      multiplier: p.multiplier,
      quantity: p.quantity,
      openDate: p.openDate,
      openPrice: p.openPrice.toFixed(6),
      openFees: (p.openFees ?? 0).toFixed(6),
      closeDate: p.closeDate ?? null,
      closePrice: p.closePrice === undefined || p.closePrice === null ? null : p.closePrice.toFixed(6),
      closeFees: p.closeFees === undefined || p.closeFees === null ? null : p.closeFees.toFixed(6),
      status: p.status ?? 'open',
      realizedPnl: p.realizedPnl === undefined || p.realizedPnl === null ? null : p.realizedPnl.toFixed(6),
      source: p.source ?? 'manual',
      notes: p.notes ?? null,
      spotAtOpen: p.spotAtOpen === undefined || p.spotAtOpen === null ? null : p.spotAtOpen.toFixed(6),
      pnlBasis: p.pnlBasis ?? null,
      importKey: p.importKey ?? null,
      flags: p.flags ?? [],
    })
    .onConflictDoNothing()
    .returning({ id: positions.id });
  return rows[0]?.id ?? null;
}

export async function linkRolledPosition(db: DbOrTx, fromId: number, toId: number): Promise<void> {
  await db.update(positions).set({ rolledTo: toId }).where(eq(positions.id, fromId));
}

/** Records the outcome of an open position. Realised P&L is (credit - close) x multiplier x contracts - fees. */
export async function closePosition(
  db: DbOrTx,
  id: number,
  c: {
    closeDate: string;
    closePrice: number;
    closeFees?: number;
    status: 'closed' | 'expired' | 'assigned' | 'rolled';
    pnlBasis?: string;
  },
): Promise<{ realizedPnl: number } | null> {
  const [p] = await db.select().from(positions).where(eq(positions.id, id));
  if (p?.status !== 'open') return null;
  const feesCents = Math.round((Number(p.openFees) + (c.closeFees ?? 0)) * 100);
  const cents = pnlCents(Number(p.openPrice), c.closePrice, p.multiplier, p.quantity, feesCents);
  const pnl = cents / 100;
  await db
    .update(positions)
    .set({
      status: c.status,
      closeDate: c.closeDate,
      closePrice: c.closePrice.toFixed(6),
      closeFees: (c.closeFees ?? 0).toFixed(6),
      realizedPnl: pnl.toFixed(6),
      pnlBasis: c.pnlBasis ?? 'cash',
    })
    .where(eq(positions.id, id));
  return { realizedPnl: pnl };
}

// ------------------------------------------------------------------- jobs
export async function startJob(db: DbOrTx, job: string, meta?: unknown): Promise<number> {
  const [r] = await db
    .insert(jobRuns)
    .values({ job, status: 'running', meta: meta ?? null })
    .returning({ id: jobRuns.id });
  return (r as { id: number }).id;
}

export async function finishJob(
  db: DbOrTx,
  id: number,
  r: { status: 'ok' | 'partial' | 'failed'; rowsWritten?: number; error?: string | null; meta?: unknown },
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      finishedAt: sql`now()`,
      status: r.status,
      rowsWritten: r.rowsWritten ?? null,
      error: r.error ?? null,
      meta: r.meta ?? null,
    })
    .where(eq(jobRuns.id, id));
}

// ------------------------------------------------------------------ params
export interface LoadedParams {
  id: number;
  name: string;
  version: number;
  hash: string;
  params: StrategyParams;
}

/** Latest version of a named strategy_params row, resolved against the current defaults. */
export async function loadParams(db: DbOrTx, name = 'default'): Promise<LoadedParams> {
  const [r] = await db
    .select()
    .from(strategyParams)
    .where(eq(strategyParams.name, name))
    .orderBy(desc(strategyParams.version))
    .limit(1);
  if (!r) throw new Error(`strategy_params "${name}" not found: run \`pnpm db:migrate\``);
  const params = resolveParams(r.params);
  return { id: r.id, name: r.name, version: r.version, hash: paramsHash(params), params };
}

export async function lastBarDay(db: DbOrTx, instrumentId: number): Promise<string | null> {
  const [r] = await db
    .select({ d: sql<string | null>`max(${priceBars.day})` })
    .from(priceBars)
    .where(eq(priceBars.instrumentId, instrumentId));
  return r?.d ?? null;
}
