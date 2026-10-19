/**
 * Reads of stored backtests, shared by the CLI and the API so both show the same numbers.
 * Views are the API contract types (a types-only import: api-types.ts has no runtime code).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { backtestRuns, backtestTrades, instruments } from '../db/schema';
import type {
  BacktestDetailView,
  BacktestHeadline,
  BacktestMetricsView,
  BacktestRequestInput,
  BacktestSummaryView,
  BacktestTradeView,
  BacktestWalkForwardView,
  TierPolicy,
} from './views';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBacktestId(s: string): boolean {
  return UUID.test(s);
}

type RunRow = typeof backtestRuns.$inferSelect;

function headlineOf(r: RunRow): BacktestHeadline | null {
  const m = r.metrics as BacktestMetricsView | null;
  if (!m) return null;
  return {
    trades: m.trades.n,
    winRate: m.trades.winRate,
    totalReturn: m.equity.totalReturn,
    cagr: m.equity.cagr,
    sharpe: m.equity.sharpe,
    maxDrawdown: m.equity.maxDrawdown,
  };
}

export function summaryOf(r: RunRow): BacktestSummaryView {
  return {
    id: r.id,
    name: r.name,
    status: r.status as BacktestSummaryView['status'],
    from: r.fromDate,
    to: r.toDate,
    tierPolicy: r.tierPolicy as TierPolicy,
    names: r.instrumentIds.length,
    progress: Number(r.progress),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    error: r.error,
    headline: headlineOf(r),
  };
}

export async function listBacktests(db: Db, limit = 50): Promise<BacktestSummaryView[]> {
  const rows = await db
    .select()
    .from(backtestRuns)
    .orderBy(desc(backtestRuns.startedAt), desc(backtestRuns.id))
    .limit(limit);
  return rows.map(summaryOf);
}

export async function getBacktest(db: Db, id: string): Promise<BacktestDetailView | null> {
  if (!isBacktestId(id)) return null;
  const [r] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
  if (!r) return null;
  return {
    ...summaryOf(r),
    initialCapital: Number(r.initialCapital),
    request: (r.request as BacktestRequestInput | null) ?? null,
    metrics: (r.metrics as BacktestMetricsView | null) ?? null,
    equityCurve: (r.equityCurve as BacktestDetailView['equityCurve'] | null) ?? [],
    walkForward: (r.walkForward as BacktestWalkForwardView | null) ?? null,
  };
}

export async function listBacktestTrades(
  db: Db,
  id: string,
  opts: { shadow?: boolean } = {},
): Promise<BacktestTradeView[]> {
  if (!isBacktestId(id)) return [];
  const rows = await db
    .select({ t: backtestTrades, i: instruments })
    .from(backtestTrades)
    .innerJoin(instruments, eq(instruments.id, backtestTrades.instrumentId))
    .where(eq(backtestTrades.backtestRunId, id))
    .orderBy(backtestTrades.entryDate, backtestTrades.id);
  const out = rows.map(({ t, i }): BacktestTradeView => {
    const scores = (t.scores ?? {}) as { shadow?: boolean };
    return {
      id: t.id,
      symbol: i.symbol,
      market: i.market,
      entryDate: t.entryDate,
      expiry: t.expiry,
      strike: Number(t.strike),
      contracts: t.contracts,
      entryCredit: Number(t.entryCredit),
      entryDelta: t.entryDelta === null ? null : Number(t.entryDelta),
      entryUnderlying: Number(t.entryUnderlying),
      exitDate: t.exitDate,
      exitReason: t.exitReason,
      exitDebit: Number(t.exitDebit),
      exitUnderlying: Number(t.exitUnderlying),
      pnl: Number(t.pnl),
      roc: Number(t.roc),
      daysHeld: t.daysHeld,
      tier: t.tier,
      shadow: scores.shadow === true,
    };
  });
  return opts.shadow ? out : out.filter((t) => !t.shadow);
}

const CSV_COLUMNS: (keyof BacktestTradeView)[] = [
  'symbol',
  'market',
  'entryDate',
  'expiry',
  'strike',
  'contracts',
  'entryCredit',
  'entryDelta',
  'entryUnderlying',
  'exitDate',
  'exitReason',
  'exitDebit',
  'exitUnderlying',
  'pnl',
  'roc',
  'daysHeld',
  'tier',
  'shadow',
];

/** RFC 4180 CSV of a run's trades; a cell starting with = + - @ is prefixed so a spreadsheet cannot run it as a formula. */
export function tradesToCsv(trades: BacktestTradeView[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of trades) lines.push(CSV_COLUMNS.map((c) => cell(t[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export async function failOrphanedBacktests(db: Db, reason: string): Promise<number> {
  const rows = await db
    .update(backtestRuns)
    .set({ status: 'failed', finishedAt: new Date(), error: reason })
    .where(and(eq(backtestRuns.status, 'running')))
    .returning({ id: backtestRuns.id });
  return rows.length;
}
