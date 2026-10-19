/**
 * Pipeline runner (docs/02 section 2). Pure orchestration over injected ports: no database, no provider, no clock.
 *
 *  1. freshness gate per input source (T3): stale -> dropped with `data.stale`, or tagged STALE with --allow-stale;
 *  2. S0-S4 in topological order, each cached under (instrument, asOf, skill, version, paramsHash);
 *     `scan` mode short-circuits on a FAIL from the regime or the fundamental gate (T4), `full` runs every skill;
 *  3. S5 is recomputed on every run, never cached (T14); open positions are excluded here;
 *  4. per market: rank by composite, apply maxPerSector / maxPerCurrency / topN;
 *  5. S6 sizing sequentially down the ranking so caps hold across the shortlist; S7 narrative.
 */
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import type { StrategyParams } from '../core/params';
import type { Instrument, PortfolioState, Reason } from '../core/types';
import { type AnalysisSkill, gateReason, type SkillContext, type SkillResult } from './contract';
import { createDataAccess, type InstrumentHistory } from './data-access';
import { evaluateFreshness, type FreshnessResult, type StaleFinding, staleReasons } from './freshness';
import { cacheParamsHash, topoSort } from './registry';
import type { OptionSelectPayload } from './s4-option-select';
import type { CompositePayload } from './s5-rank-composite';
import type { SizingPayload } from './s6-size-position';

export interface RunnerPorts {
  /** Loads one instrument's history; implementations cache it per run (one bars query per instrument). */
  loadHistory(instrumentId: number): Promise<InstrumentHistory>;
  cacheGet(
    instrumentId: number,
    asOf: ISODate,
    skillId: string,
    version: string,
    hash: string,
  ): Promise<SkillResult | null>;
  cachePut(instrumentId: number, asOf: ISODate, hash: string, result: SkillResult, durationMs: number): Promise<void>;
  /** Monotonic milliseconds (injected so the runner never reads a clock itself). */
  timer(): number;
}

export interface WatchInstrument extends Instrument {
  conviction: number | null;
  /** Per-name collateral cap as a fraction of equity, or null for the global default. */
  maxCollateralPct: number | null;
}

export interface RunOptions {
  asOf: ISODate;
  params: StrategyParams;
  mode: 'scan' | 'full';
  /** `enforce` drops stale names (scan); `report` only attaches the findings (explain). */
  gate: 'enforce' | 'report';
  allowStale: boolean;
  portfolio: PortfolioState;
  /** Knowledge cutoff for filings and events; see DataAccessOptions.knownThrough. Default: asOf. */
  knownThrough?: ISODate;
}

export type NameStatus = 'dropped_stale' | 'failed' | 'excluded' | 'ranked' | 'cut' | 'no_contract' | 'candidate';

export interface NameResult {
  instrument: WatchInstrument;
  status: NameStatus;
  results: Record<string, SkillResult>;
  stale: StaleFinding[];
  /** Ranked despite stale inputs because of --allow-stale. */
  staleTagged: boolean;
  freshChain: boolean;
  chainAgeDays: number | null;
  /** The reason that decided a FAIL / drop, with the skill that raised it. */
  binding: { skillId: string; reason: Reason } | null;
  composite: number | null;
  rank: number | null;
  cutReason: string | null;
  shortCircuited: boolean;
}

export interface RunReport {
  asOf: ISODate;
  mode: RunOptions['mode'];
  paramsHash: string;
  names: NameResult[];
  /** Ranked shortlist per market, rank order. */
  shortlist: Record<Market, NameResult[]>;
  /** HK (no fresh chain) names worth pasting a chain for, by composite, capped at runner.pasteTopN. */
  pasteList: NameResult[];
  stats: { cacheHits: number; computed: number; byInstrument: Record<number, { hits: number; computed: number }> };
}

interface Internal {
  ctx: SkillContext;
  priors: Map<string, SkillResult>;
  fresh: FreshnessResult;
}

function errorResult(skill: AnalysisSkill, err: unknown): SkillResult {
  return {
    skillId: skill.id,
    version: skill.version,
    score: null,
    verdict: 'FAIL',
    reasons: [
      {
        rule: 'skill.error',
        value: (err as Error).message,
        passed: false,
        level: 'FAIL',
        kind: 'rule',
        note: `${skill.id} threw: ${(err as Error).message}`,
      },
    ],
    payload: {},
    dataQuality: { tier: 'proxy', missing: ['skill.error'] },
  };
}

export async function runPipeline(
  ports: RunnerPorts,
  instruments: WatchInstrument[],
  opts: RunOptions,
): Promise<RunReport> {
  const { params, asOf } = opts;
  const order = topoSort();
  const cacheable = order.filter((s) => s.cacheable);
  const s5 = order.find((s) => s.id === 'rank.composite') as AnalysisSkill;
  const s6 = order.find((s) => s.id === 'size.position') as AnalysisSkill;
  const s7 = order.find((s) => s.id === 'explain.narrative') as AnalysisSkill;
  const hash = cacheParamsHash(params, undefined, {
    asOf,
    ...(opts.knownThrough ? { knownThrough: opts.knownThrough } : {}),
  });
  const stats: RunReport['stats'] = { cacheHits: 0, computed: 0, byInstrument: {} };
  const internal = new Map<number, Internal>();
  const names: NameResult[] = [];

  const exec = async (skill: AnalysisSkill, ctx: SkillContext): Promise<SkillResult> => {
    try {
      return await skill.run(ctx);
    } catch (err) {
      return errorResult(skill, err);
    }
  };

  // --------------------------------------------------------------- per name: gate, S0-S5
  for (const inst of instruments) {
    const history = await ports.loadHistory(inst.id);
    const priors = new Map<string, SkillResult>();
    const memo = new Map<string, unknown>();
    const data = createDataAccess(history, asOf, {
      chainMaxAgeDays: params.runner.chainMaxAgeDays,
      priors,
      memo,
      ...(opts.knownThrough ? { knownThrough: opts.knownThrough } : {}),
    });
    const sources = await data.sources();
    const fresh = evaluateFreshness({
      instrument: inst,
      sources,
      asOf,
      baseCurrency: opts.portfolio.baseCurrency,
      chainMaxAgeDays: params.runner.chainMaxAgeDays,
    });
    const name: NameResult = {
      instrument: inst,
      status: 'candidate',
      results: {},
      stale: fresh.stale,
      staleTagged: false,
      freshChain: fresh.hasFreshChain,
      chainAgeDays: fresh.chainAgeDays,
      binding: null,
      composite: null,
      rank: null,
      cutReason: null,
      shortCircuited: false,
    };
    names.push(name);
    stats.byInstrument[inst.id] = { hits: 0, computed: 0 };

    if (fresh.stale.length > 0) {
      if (opts.gate === 'enforce' && !opts.allowStale) {
        name.status = 'dropped_stale';
        name.binding = { skillId: 'freshness.gate', reason: staleReasons(fresh.stale)[0] as Reason };
        continue;
      }
      name.staleTagged = true;
    }

    const ctx: SkillContext = {
      instrument: inst,
      asOf,
      params,
      data,
      portfolio: opts.portfolio,
      conviction: inst.conviction,
      maxCollateralPct: inst.maxCollateralPct,
      log: () => {},
    };
    internal.set(inst.id, { ctx, priors, fresh });

    for (const skill of cacheable) {
      const cached = await ports.cacheGet(inst.id, asOf, skill.id, skill.version, hash);
      let result: SkillResult;
      if (cached) {
        result = cached;
        stats.cacheHits++;
        (stats.byInstrument[inst.id] as { hits: number }).hits++;
      } else {
        const t0 = ports.timer();
        result = await exec(skill, ctx);
        stats.computed++;
        (stats.byInstrument[inst.id] as { computed: number }).computed++;
        if (result.dataQuality.missing[0] !== 'skill.error')
          await ports.cachePut(inst.id, asOf, hash, result, Math.round(ports.timer() - t0));
      }
      priors.set(skill.id, result);
      name.results[skill.id] = result;
      // scan mode: a FAIL from the gate skills stops the pipeline for this name (speed); full mode never does
      if (
        opts.mode === 'scan' &&
        (skill.id === 'market.regime' || skill.id === 'fundamental.gate') &&
        result.verdict === 'FAIL'
      ) {
        name.shortCircuited = true;
        break;
      }
    }

    if (!name.shortCircuited) {
      const r5 = await exec(s5, ctx);
      priors.set(s5.id, r5);
      name.results[s5.id] = r5;
    }

    // classify: a FAIL anywhere, or a WARN the gate treats as a block (GATE_WAIT_RULES), keeps the name off the shortlist
    const failing = Object.values(name.results).find((r) => gateReason(r) !== null);
    const r5res = name.results[s5.id] as SkillResult<CompositePayload> | undefined;
    const bind = r5res && gateReason(r5res) ? r5res : failing;
    if (bind) {
      const b = gateReason(bind) as Reason;
      name.binding = { skillId: bind.skillId, reason: b };
    }
    name.composite = r5res?.payload.composite ?? null;
    if (failing || (r5res && r5res.verdict === 'FAIL')) name.status = 'failed';
    else if (r5res?.payload.excluded === 'alreadyOpen') name.status = 'excluded';
    else if (
      !(name.results['option.select'] as SkillResult<OptionSelectPayload> | undefined)?.payload.chosen ||
      name.composite === null
    )
      name.status = 'no_contract';
    else name.status = 'candidate';
  }

  // --------------------------------------------------------------- rank per market
  const shortlist: Record<Market, NameResult[]> = { US: [], HK: [] };
  for (const market of ['US', 'HK'] as Market[]) {
    const cands = names
      .filter((n) => n.status === 'candidate' && n.instrument.market === market)
      .sort(
        (a, b) =>
          (b.composite as number) - (a.composite as number) || a.instrument.symbol.localeCompare(b.instrument.symbol),
      );
    const bySector = new Map<string, number>();
    const byCcy = new Map<string, number>();
    for (const n of cands) {
      const sector = n.instrument.sector ?? 'unknown';
      const ccy = n.instrument.currency;
      if (shortlist[market].length >= params.runner.topN) {
        n.status = 'cut';
        n.cutReason = `below the top ${params.runner.topN}`;
      } else if ((bySector.get(sector) ?? 0) >= params.runner.maxPerSector) {
        n.status = 'cut';
        n.cutReason = `sector limit: ${params.runner.maxPerSector} per sector (${sector})`;
      } else if ((byCcy.get(ccy) ?? 0) >= params.runner.maxPerCurrency) {
        n.status = 'cut';
        n.cutReason = `currency limit: ${params.runner.maxPerCurrency} per currency (${ccy})`;
      } else {
        n.status = 'ranked';
        n.rank = shortlist[market].length + 1;
        shortlist[market].push(n);
        bySector.set(sector, (bySector.get(sector) ?? 0) + 1);
        byCcy.set(ccy, (byCcy.get(ccy) ?? 0) + 1);
      }
    }
  }

  // --------------------------------------------------------------- S6 sizing (sequential per market) and S7
  const sized = new Set<number>();
  for (const market of ['US', 'HK'] as Market[]) {
    let committedBase = 0;
    const committedBySector: Record<string, number> = {};
    for (const n of shortlist[market]) {
      const it = internal.get(n.instrument.id) as Internal;
      const portfolio: PortfolioState = {
        ...opts.portfolio,
        committedBase,
        committedBySector: { ...committedBySector },
      };
      const r6 = await exec(s6, { ...it.ctx, portfolio });
      it.priors.set(s6.id, r6);
      n.results[s6.id] = r6;
      sized.add(n.instrument.id);
      // the drawdown governor's halt (size.dailyLossHalt) is portfolio-wide: every idea waits for the day
      const halt = r6.reasons.find((r) => r.rule === 'size.dailyLossHalt' && r.level === 'FAIL');
      if (halt) {
        n.status = 'failed';
        n.binding = { skillId: s6.id, reason: halt };
        n.rank = null;
        continue;
      }
      const z = (r6 as SkillResult<SizingPayload>).payload;
      if (z.contracts > 0) {
        committedBase += z.collateralBaseCcy;
        const sector = n.instrument.sector;
        if (sector) committedBySector[sector] = (committedBySector[sector] ?? 0) + 1;
      }
    }
    shortlist[market] = shortlist[market].filter((n) => n.status === 'ranked');
  }
  for (const n of names) {
    const it = internal.get(n.instrument.id);
    if (!it) continue;
    if (opts.mode === 'full' && !sized.has(n.instrument.id) && n.results['option.select']) {
      const r6 = await exec(s6, it.ctx);
      it.priors.set(s6.id, r6);
      n.results[s6.id] = r6;
    }
    const r7 = await exec(s7, it.ctx);
    n.results[s7.id] = r7;
  }

  // --------------------------------------------------------------- paste-chains block (HK without a fresh chain)
  const pasteList = names
    .filter(
      (n) =>
        n.instrument.market === 'HK' &&
        !n.freshChain &&
        (n.status === 'ranked' || n.status === 'cut' || n.status === 'candidate') &&
        n.composite !== null,
    )
    .sort(
      (a, b) =>
        (b.composite as number) - (a.composite as number) || a.instrument.symbol.localeCompare(b.instrument.symbol),
    )
    .slice(0, params.runner.pasteTopN);

  return { asOf, mode: opts.mode, paramsHash: hash, names, shortlist, pasteList, stats };
}
