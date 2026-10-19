import { and, eq } from 'drizzle-orm';
import type { Reason } from '../core/types';
import type { RunReport } from '../skills/runner';
import type { OptionSelectPayload } from '../skills/s4-option-select';
import type { CompositePayload } from '../skills/s5-rank-composite';
import type { SizingPayload } from '../skills/s6-size-position';
import type { NarrativePayload } from '../skills/s7-explain-narrative';
import type { Db } from './client';
import type { LoadedParams } from './repos';
import { optionContracts, recommendations, scanRuns } from './schema';

/** Persists a live scan: one scan_runs row and one recommendations row per ranked name. Returns the scan run id. */
export async function saveScanRun(
  db: Db,
  params: LoadedParams,
  report: RunReportLike,
  startedAt: Date,
): Promise<string> {
  const [run] = await db
    .insert(scanRuns)
    .values({
      asOf: report.asOf,
      paramsId: params.id,
      mode: 'live',
      startedAt,
      finishedAt: new Date(),
      status: 'done',
      stats: {
        cacheHits: report.stats.cacheHits,
        computed: report.stats.computed,
        ranked: { US: report.shortlist.US.length, HK: report.shortlist.HK.length },
        dropped: report.names.filter((n) => n.status === 'dropped_stale').map((n) => n.instrument.symbol),
        paramsHash: report.paramsHash,
      },
    })
    .returning({ id: scanRuns.id });
  const scanRunId = (run as { id: string }).id;

  for (const market of ['US', 'HK'] as const) {
    for (const n of report.shortlist[market]) {
      const s4 = n.results['option.select']?.payload as OptionSelectPayload | undefined;
      const s5 = n.results['rank.composite']?.payload as CompositePayload | undefined;
      const s6 = n.results['size.position']?.payload as SizingPayload | undefined;
      const s7 = n.results['explain.narrative']?.payload as NarrativePayload | undefined;
      const c = s4?.chosen;
      if (!c || !s5 || s5.composite === null) continue;
      let contractId: number | null = null;
      if (c.contractId === 'chain') {
        const [row] = await db
          .select({ id: optionContracts.id })
          .from(optionContracts)
          .where(
            and(
              eq(optionContracts.instrumentId, n.instrument.id),
              eq(optionContracts.right, 'P'),
              eq(optionContracts.strike, c.strike.toFixed(6)),
              eq(optionContracts.expiry, c.expiry),
            ),
          );
        contractId = row?.id ?? null;
      }
      const reasons: Reason[] = (s7?.reasons ?? []).map((r) => ({ ...r }));
      await db.insert(recommendations).values({
        scanRunId,
        instrumentId: n.instrument.id,
        asOf: report.asOf,
        rank: n.rank as number,
        contractId,
        syntheticContract:
          c.contractId === 'synthetic'
            ? { strike: c.strike, expiry: c.expiry, multiplier: n.instrument.multiplier }
            : null,
        underlyingPrice: (s4?.spot ?? 0).toFixed(6),
        strike: c.strike.toFixed(6),
        expiry: c.expiry,
        dte: c.dte,
        delta: c.delta.toFixed(6),
        creditPerContract: c.credit.toFixed(6),
        collateralPerContract: c.collateral.toFixed(6),
        collateralBaseCcy: (c.collateralBaseCcy ?? 0).toFixed(6),
        marginEstimate: c.marginEstimate === null ? null : c.marginEstimate.toFixed(6),
        rocOnMargin: c.rocOnMargin === null ? null : c.rocOnMargin.toFixed(6),
        roc: c.roc.toFixed(6),
        annualizedRoc: c.annRoc.toFixed(6),
        breakeven: c.breakeven.toFixed(6),
        cushionPct: c.cushionPct.toFixed(6),
        probItm: c.probItm.toFixed(4),
        probTouch: c.probTouch.toFixed(4),
        expectedValue: c.expectedValue === null ? null : c.expectedValue.toFixed(6),
        supportLevel: s4?.support === null || s4?.support === undefined ? null : s4.support.toFixed(6),
        fundamentalScore: s5.scores.fundamental === null ? null : s5.scores.fundamental.toFixed(2),
        technicalScore: s5.scores.technical === null ? null : s5.scores.technical.toFixed(2),
        volScore: s5.scores.vol === null ? null : s5.scores.vol.toFixed(2),
        optionScore: s5.scores.option === null ? null : s5.scores.option.toFixed(2),
        composite: s5.composite.toFixed(2),
        confidence: s5.confidence === null ? null : s5.confidence.toFixed(4),
        suggestedContracts: s6?.contracts ?? null,
        suggestedCollateral: s6 ? s6.collateralBaseCcy.toFixed(2) : null,
        reasons,
        narrative: s7?.text ?? null,
        backtestCard: s5.backtestCard,
        dataTier: n.results['rank.composite']?.dataQuality.tier ?? 'proxy',
      });
    }
  }
  return scanRunId;
}

type RunReportLike = Pick<RunReport, 'asOf' | 'stats' | 'shortlist' | 'names' | 'paramsHash'>;
