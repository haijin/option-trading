import type { StrategyParams } from '../core/params';
import { hashParams } from '../core/util';
import type { AnalysisSkill } from './contract';
import { marketRegime } from './s0-market-regime';
import { fundamentalGate } from './s1-fundamental-gate';
import { technicalTiming } from './s2-technical-timing';
import { volatilityEdge } from './s3-volatility-edge';
import { optionSelect } from './s4-option-select';
import { rankComposite } from './s5-rank-composite';
import { sizePosition } from './s6-size-position';
import { explainNarrative } from './s7-explain-narrative';
import { leadersPullback } from './s8-leaders-pullback';

export const SKILLS: readonly AnalysisSkill[] = [
  marketRegime,
  fundamentalGate,
  technicalTiming,
  volatilityEdge,
  optionSelect,
  rankComposite,
  sizePosition,
  explainNarrative,
] as AnalysisSkill[];

/**
 * Skills with their own job that the sell-put pipeline never runs (`runPipeline` orders `SKILLS` only): the Leaders page's
 * pullback screen. Registered here so the skill list stays in one place.
 */
export const STANDALONE_SKILLS: readonly AnalysisSkill[] = [leadersPullback] as AnalysisSkill[];

/** Every skill, pipeline and standalone. */
export const ALL_SKILLS: readonly AnalysisSkill[] = [...SKILLS, ...STANDALONE_SKILLS];

/** Topological order by `dependsOn` (stable: registry order among independent skills). Throws on a cycle or unknown id. */
export function topoSort(skills: readonly AnalysisSkill[] = SKILLS): AnalysisSkill[] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const out: AnalysisSkill[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: AnalysisSkill): void => {
    const st = state.get(s.id);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`skill dependency cycle at ${s.id}`);
    state.set(s.id, 'visiting');
    for (const d of s.dependsOn) {
      const dep = byId.get(d);
      if (!dep) throw new Error(`skill ${s.id} depends on unknown skill ${d}`);
      visit(dep);
    }
    state.set(s.id, 'done');
    out.push(s);
  };
  for (const s of skills) visit(s);
  return out;
}

/** Namespaces whose values can change a cached (S0-S4) result. */
const CACHED_NAMESPACES = [
  'market.regime',
  'fundamental.gate',
  'technical.timing',
  'volatility.edge',
  'option.select',
] as const;

/**
 * The params hash in the cache key of every cacheable skill. Deliberately coarse and therefore safe: it covers every
 * cacheable skill's namespace (S1 reads option.select.dteMax, S3 reads the risk-free rate, S4 reads the calibration
 * threshold), the versions of all cacheable skills, and `runner.chainMaxAgeDays` (it decides whether a pasted chain
 * is visible). S5-S7 are never cached, so their parameters are not part of it.
 */
export function cacheParamsHash(
  params: StrategyParams,
  skills: readonly AnalysisSkill[] = SKILLS,
  extra: { asOf?: string; knownThrough?: string } = {},
): string {
  const picked: Record<string, unknown> = {};
  for (const k of CACHED_NAMESPACES) picked[k] = params[k];
  const versions = Object.fromEntries(skills.filter((s) => s.cacheable).map((s) => [s.id, s.version]));
  // A live scan knows more than the as-of date (knownThrough > asOf): that is part of what the result depends on.
  const known = extra.knownThrough && extra.asOf && extra.knownThrough > extra.asOf ? extra.knownThrough : undefined;
  return hashParams({ params: picked, versions, chainMaxAgeDays: params.runner.chainMaxAgeDays, knownThrough: known });
}
