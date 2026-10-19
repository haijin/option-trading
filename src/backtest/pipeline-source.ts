/**
 * The live pipeline, replayed as of each backtest day (docs/05 section 2). The engine asks for candidates on a scan day;
 * this runs `runPipeline` with asOf = that day over history that is bounded by asOf, so a rule can never see the
 * future (tests/skills/lookahead.test.ts proves it for the skills; the engine adds only the engine's own state).
 *
 * `observe` runs the pipeline in `full` mode and also returns the entries it REJECTED as shadow candidates, so the
 * per-rule attribution can compare rule-passing and rule-failing entries (docs/05 section 4; roughly doubles compute).
 */
import type { Market } from '../core/calendar';
import type { StrategyParams } from '../core/params';
import type { Currency, PortfolioState } from '../core/types';
import { type NameResult, type RunnerPorts, runPipeline, type WatchInstrument } from '../skills/runner';
import type { OptionSelectPayload } from '../skills/s4-option-select';
import type { CompositePayload } from '../skills/s5-rank-composite';
import type { SizingPayload } from '../skills/s6-size-position';
import type { EntryCandidate, EntrySource } from './engine';

export interface PipelineSourceOptions {
  ports: RunnerPorts;
  instruments: WatchInstrument[];
  params: StrategyParams;
  baseCurrency: Currency;
  observe: boolean;
}

/** Rule id -> passed, across every skill's rule-kind reasons (data-quality warnings are not rules). */
export function ruleMap(n: NameResult): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of Object.values(n.results))
    for (const x of r.reasons) if (x.kind !== 'data' && x.level !== 'INFO') out[x.rule] = x.passed;
  return out;
}

function candidateOf(n: NameResult, shadow: boolean): EntryCandidate | null {
  const sel = n.results['option.select']?.payload as OptionSelectPayload | undefined;
  const chosen = sel?.chosen;
  if (!sel || !chosen || sel.tier === null) return null;
  const sizing = n.results['size.position']?.payload as SizingPayload | undefined;
  const composite = (n.results['rank.composite']?.payload as CompositePayload | undefined)?.composite ?? null;
  return {
    instrumentId: n.instrument.id,
    strike: chosen.strike,
    expiry: chosen.expiry,
    fillPrice: chosen.fillPrice,
    delta: chosen.delta,
    iv: chosen.iv,
    contracts: shadow ? 1 : (sizing?.contracts ?? 0),
    score: composite ?? 0,
    tier: sel.tier,
    ...(shadow ? { shadow: true } : {}),
    rules: ruleMap(n),
  };
}

export function createPipelineSource(o: PipelineSourceOptions): EntrySource {
  return {
    async candidates(day, view) {
      const portfolio: PortfolioState = {
        baseCurrency: o.baseCurrency,
        equity: view.equity,
        openPositions: view.openPositions.map((p) => ({
          instrumentId: p.instrumentId,
          symbol: p.symbol,
          market: p.market,
          sector: p.sector,
          currency: p.currency,
          strike: p.strike,
          multiplier: p.multiplier,
          quantity: p.quantity,
          expiry: p.expiry,
        })),
        fxToBase: (ccy) => view.fxToBase(ccy),
      };
      const report = await runPipeline(o.ports, o.instruments, {
        asOf: day,
        params: o.params,
        mode: o.observe ? 'full' : 'scan',
        gate: 'enforce',
        allowStale: false,
        portfolio,
      });
      const out: EntryCandidate[] = [];
      for (const market of ['US', 'HK'] as Market[])
        for (const n of report.shortlist[market]) {
          const c = candidateOf(n, false);
          if (c) out.push(c);
        }
      out.sort((a, b) => b.score - a.score);
      if (o.observe) {
        // Everything that had a contract but did not make the shortlist: failed a rule, cut by a limit, or already open.
        for (const n of report.names) {
          if (n.status === 'ranked' || n.status === 'dropped_stale' || n.status === 'excluded') continue;
          const c = candidateOf(n, true);
          if (c) out.push(c);
        }
      }
      return out;
    },
  };
}

/** Wraps a source so each day's proposals are computed once and replayed; sensitivity re-runs then cost only pricing. */
export function memoSource(inner: EntrySource): EntrySource & { size(): number } {
  const cache = new Map<string, EntryCandidate[]>();
  return {
    async candidates(day, view) {
      const hit = cache.get(day);
      if (hit) return hit;
      const fresh = await inner.candidates(day, view);
      cache.set(day, fresh);
      return fresh;
    },
    size: () => cache.size,
  };
}
