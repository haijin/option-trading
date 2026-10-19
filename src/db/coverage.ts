/** Fundamentals coverage report: how much of S1's input the free data actually supplies (docs/07 Q14). */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { fundamentalStatements } from './schema';

export const KEY_FIELDS = [
  'revenue',
  'grossProfit',
  'ebit',
  'ebitda',
  'interestExpense',
  'netIncome',
  'epsDiluted',
  'sharesDiluted',
  'totalAssets',
  'currentAssets',
  'currentLiabilities',
  'totalLiabilities',
  'longTermDebt',
  'totalDebt',
  'cash',
  'retainedEarnings',
  'totalEquity',
  'cfo',
  'capex',
  'fcf',
  'dividendsPaid',
] as const;

export interface CoverageRow {
  annual: number;
  quarterly: number;
  semiannual: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
  /** Key fields that are null on the latest annual statement. */
  missingLatestAnnual: string[];
  /** Total null key-field cells across all annual statements, and the number of cells examined. */
  missingCells: number;
  totalCells: number;
  /** What the 5-year medians and trend tests in S1 can use. */
  supports: { fScore: boolean; revenueCagr3y: boolean; roic5y: boolean; valuationZ5y: boolean; gmStdev8: boolean };
}

export function computeCoverage(
  rows: { periodEnd: string; periodType: string; values: Record<string, number | null> }[],
): CoverageRow {
  const annual = rows.filter((r) => r.periodType === 'annual').sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const quarterly = rows.filter((r) => r.periodType === 'quarterly').length;
  const semiannual = rows.filter((r) => r.periodType === 'semiannual').length;
  const latest = annual[annual.length - 1];
  let missingCells = 0;
  for (const r of annual)
    for (const f of KEY_FIELDS) if (r.values[f] === null || r.values[f] === undefined) missingCells++;
  const sub = rows.filter((r) => r.periodType !== 'annual' && r.periodType !== 'ttm').length;
  return {
    annual: annual.length,
    quarterly,
    semiannual,
    firstPeriod: rows.length
      ? ([...rows].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))[0]?.periodEnd ?? null)
      : null,
    lastPeriod: rows.length
      ? ([...rows].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0]?.periodEnd ?? null)
      : null,
    missingLatestAnnual: latest
      ? KEY_FIELDS.filter((f) => latest.values[f] === null || latest.values[f] === undefined)
      : [...KEY_FIELDS],
    missingCells,
    totalCells: annual.length * KEY_FIELDS.length,
    supports: {
      fScore: annual.length >= 2,
      revenueCagr3y: annual.length >= 4,
      roic5y: annual.length >= 5,
      valuationZ5y: annual.length >= 5,
      gmStdev8: sub >= 8,
    },
  };
}

export async function coverageFor(db: DbOrTx, instrumentId: number): Promise<CoverageRow> {
  const rows = await db
    .select()
    .from(fundamentalStatements)
    .where(eq(fundamentalStatements.instrumentId, instrumentId));
  return computeCoverage(
    rows.map((r) => ({
      periodEnd: r.periodEnd,
      periodType: r.periodType,
      values: Object.fromEntries(
        KEY_FIELDS.map((f) => {
          const v = (r as Record<string, unknown>)[f];
          return [f, v === null || v === undefined ? null : Number(v)];
        }),
      ),
    })),
  );
}
