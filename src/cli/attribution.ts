/**
 * Journal attribution (docs/01 G2, roadmap Phase 2): every past trade is re-scored as of its entry date with the full
 * pipeline (mode `full`, so losers are never dropped), then winners and losers are compared per rule.
 * Sample sizes are small and the report says so.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { createRunStore, loadPortfolio } from '../db/history';
import { getInstrument } from '../db/repos';
import { positions } from '../db/schema';
import { runPipeline } from '../skills';

export interface AttributionRow {
  rule: string;
  winPass: number;
  winFail: number;
  losePass: number;
  loseFail: number;
}

export interface AttributionReport {
  trades: number;
  winners: number;
  losers: number;
  skipped: number;
  rows: AttributionRow[];
}

const SKILLS_FOR_RULES = ['market.regime', 'fundamental.gate', 'technical.timing', 'volatility.edge', 'option.select'];

export async function runAttribution(db: Db): Promise<AttributionReport> {
  const trades = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.source, 'journal_import'),
        inArray(positions.status, ['closed', 'expired', 'assigned', 'rolled']),
        isNotNull(positions.realizedPnl),
      ),
    );
  const store = createRunStore(db);
  const tally = new Map<string, AttributionRow>();
  let winners = 0;
  let losers = 0;
  let skipped = 0;
  for (const t of trades) {
    const inst = await getInstrument(db, t.instrumentId);
    if (!inst) {
      skipped++;
      continue;
    }
    const base = await loadPortfolio(db, t.openDate);
    const report = await runPipeline(store.ports, [{ ...inst, conviction: null, maxCollateralPct: null }], {
      asOf: t.openDate,
      params: (await import('../core/params')).defaultParams(),
      mode: 'full',
      gate: 'report',
      allowStale: true,
      portfolio: { ...base, openPositions: [] },
    });
    const n = report.names[0];
    // no usable history as of the entry date: nothing to attribute
    if (!n || n.results['technical.timing']?.verdict === 'NA') {
      skipped++;
      continue;
    }
    const win = Number(t.realizedPnl) > 0;
    if (win) winners++;
    else losers++;
    const seen = new Set<string>();
    for (const id of SKILLS_FOR_RULES) {
      for (const r of n.results[id]?.reasons ?? []) {
        if (r.level === 'INFO' || !r.level || seen.has(r.rule)) continue;
        seen.add(r.rule);
        const row = tally.get(r.rule) ?? { rule: r.rule, winPass: 0, winFail: 0, losePass: 0, loseFail: 0 };
        const passed = r.level === 'PASS';
        if (win) passed ? row.winPass++ : row.winFail++;
        else passed ? row.losePass++ : row.loseFail++;
        tally.set(r.rule, row);
      }
    }
  }
  return {
    trades: trades.length,
    winners,
    losers,
    skipped,
    rows: [...tally.values()].sort((a, b) => a.rule.localeCompare(b.rule)),
  };
}
