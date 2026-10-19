/**
 * The skill plugin contract (docs/02 section 2). A skill is a pure, versioned function of
 * (instrument, asOf, params, data). It never reads the clock and never touches a database or provider: everything
 * arrives through `SkillContext`, and `DataAccess` is constructed with `asOf` baked in.
 */
import type { SkillParamKey, StrategyParams } from '../core/params';
import type {
  CalibrationSummary,
  Currency,
  DailyBar,
  DataSources,
  DataTier,
  EventCalendar,
  Instrument,
  IvPoint,
  JournalOutcome,
  MarketRegimeSnapshot,
  OptionChainSnapshot,
  PnlLedger,
  PointInTimeFundamentals,
  PortfolioState,
  Reason,
  Verdict,
} from '../core/types';

export interface DataAccess {
  /** The last `lookback` bars with day <= asOf (ascending). */
  bars(lookback: number): Promise<DailyBar[]>;
  /** Only statements with reportedAt <= end of asOf. */
  fundamentals(): Promise<PointInTimeFundamentals>;
  /** Latest snapshot with snapshotDate <= asOf; a pasted CSV chain older than chainMaxAgeDays counts as absent. */
  chain(): Promise<OptionChainSnapshot | null>;
  /** Stored real IV30 points with day <= asOf within the last `days` calendar days. */
  ivHistory(days: number): Promise<IvPoint[]>;
  /** Skew values stored with those points (25-delta put IV minus ATM IV), same bounds. */
  skewHistory(days: number): Promise<number[]>;
  /** Events with knownAt <= end of asOf. */
  calendar(): Promise<EventCalendar>;
  /** Benchmark index and vol-index bars, bounded by asOf. */
  market(): Promise<MarketRegimeSnapshot>;
  /** Latest rate on or before asOf to convert one unit of `from` into `to`; null when unavailable. */
  fx(from: Currency | string, to: Currency | string): Promise<number | null>;
  /** Calibration samples dated on or before asOf, summarised per delta bucket (needs >= minSamples). */
  calibration(minSamples: number): Promise<CalibrationSummary>;
  /** Realised outcomes of imported journal trades on this name, closed on or before asOf. */
  journal(): Promise<JournalOutcome[]>;
  /** Last-seen dates of every input (freshness gate). Bounded by asOf; ignores chainMaxAgeDays. */
  sources(): Promise<DataSources>;
  /**
   * Every recorded put and its marks as they stood on asOf (a close after asOf reads as still open, later marks are
   * absent): the drawdown governor's input (S6 and the alerts job). Portfolio-wide, the same for every instrument.
   */
  ledger(): Promise<PnlLedger>;
  /** Upstream results of this run for this instrument. */
  priorSkillResult<T = unknown>(skillId: string): SkillResult<T> | undefined;
  /** Run-scoped memo: S2 publishes its indicator series here so S3/S4 do not recompute them. */
  memo<T>(key: string, compute: () => T): T;
}

export interface SkillContext {
  instrument: Instrument;
  asOf: string;
  params: StrategyParams;
  data: DataAccess;
  portfolio: PortfolioState;
  /** Watchlist conviction prior (1-5) or null. */
  conviction: number | null;
  /** Per-name override of max collateral, as a fraction of equity (watchlist.max_collateral_pct / 100). */
  maxCollateralPct: number | null;
  log: (msg: string, meta?: object) => void;
  /**
   * Inputs a job publishes for ONE run of one skill that no per-instrument `DataAccess` call can answer, keyed by a
   * namespaced string (`leaders.ranks`: the market-wide percentile ranks of the Leaders scan). The sell-put pipeline never
   * sets it; a skill that reads it must say what it does without it.
   */
  extras?: Record<string, unknown>;
}

export interface SkillResult<TPayload = unknown> {
  skillId: string;
  version: string;
  /** 0-100, or null for non-scoring skills / unscored tiers. */
  score: number | null;
  verdict: Verdict;
  reasons: Reason[];
  payload: TPayload;
  dataQuality: { tier: DataTier; missing: string[] };
}

export interface AnalysisSkill<TPayload = unknown> {
  id: string;
  /** semver; stored with every result and part of the cache key. Bump when the logic changes. */
  version: string;
  dependsOn: string[];
  /** Namespace of this skill's parameters in the strategy tree (`runner` is not a skill). */
  paramKey: SkillParamKey;
  /** S5-S7 depend on portfolio state, which changes without any data write, so they are recomputed every run. */
  cacheable: boolean;
  run(ctx: SkillContext): Promise<SkillResult<TPayload>>;
}

// ------------------------------------------------------------------ reasons
export function pass(rule: string, value: Reason['value'], extra: Partial<Reason> = {}): Reason {
  return { rule, value, passed: true, level: 'PASS', ...extra };
}

export function info(rule: string, value: Reason['value'], extra: Partial<Reason> = {}): Reason {
  return { rule, value, passed: true, level: 'INFO', ...extra };
}

/** A rule-based warning: the composite multiplier applies. */
export function warnRule(rule: string, value: Reason['value'], extra: Partial<Reason> = {}): Reason {
  return { rule, value, passed: false, level: 'WARN', kind: 'rule', ...extra };
}

/** A data-quality warning (missing or estimated input): shown, never penalised in the composite. */
export function warnData(rule: string, value: Reason['value'], extra: Partial<Reason> = {}): Reason {
  return { rule, value, passed: false, level: 'WARN', kind: 'data', ...extra };
}

export function fail(rule: string, value: Reason['value'], extra: Partial<Reason> = {}): Reason {
  return { rule, value, passed: false, level: 'FAIL', kind: 'rule', ...extra };
}

export function verdictOf(reasons: readonly Reason[]): Verdict {
  if (reasons.some((r) => r.level === 'FAIL')) return 'FAIL';
  if (reasons.some((r) => r.level === 'WARN')) return 'WARN';
  return 'PASS';
}

/** The reason that decided a FAIL (first FAIL-level reason). */
export function bindingReason(result: SkillResult): Reason | null {
  return result.reasons.find((r) => r.level === 'FAIL') ?? null;
}

/**
 * WARN-level rules the pipeline gate treats as a block ("Wait") even though the skill's verdict is not FAIL: the
 * skill keeps scoring the name, the scan does not recommend it today. `vol.ivFloorRamp`: IV at its floor with a
 * result 30 to 60 days out (trade-skills pitfall 37).
 */
export const GATE_WAIT_RULES: ReadonlySet<string> = new Set(['vol.ivFloorRamp']);

/** The reason the gate acts on: the first FAIL, else the first WARN in GATE_WAIT_RULES. */
export function gateReason(result: SkillResult): Reason | null {
  return bindingReason(result) ?? result.reasons.find((r) => r.level === 'WARN' && GATE_WAIT_RULES.has(r.rule)) ?? null;
}

export function hasRuleWarn(result: SkillResult): boolean {
  return result.reasons.some((r) => r.level === 'WARN' && r.kind !== 'data');
}
