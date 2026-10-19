/** Maps the pipeline's NameResult objects to the JSON views of api-types.ts. Pure: no database, no clock. */
import type { ISODate } from '../core/dates';
import type { Instrument, Reason } from '../core/types';
import type { SkillResult } from '../skills/contract';
import type { NameResult } from '../skills/runner';
import type { RegimePayload } from '../skills/s0-market-regime';
import type { TechnicalPayload } from '../skills/s2-technical-timing';
import type { ContractChoice, OptionSelectPayload } from '../skills/s4-option-select';
import type { CompositePayload } from '../skills/s5-rank-composite';
import type { SizingPayload } from '../skills/s6-size-position';
import type { NarrativePayload } from '../skills/s7-explain-narrative';
import type {
  ContractView,
  IdeaView,
  OpenNameView,
  ReasonView,
  RegimeView,
  RejectStatus,
  RejectView,
  SizingView,
  SkillRowView,
} from './api-types';

export const SKILL_ORDER = [
  'market.regime',
  'fundamental.gate',
  'technical.timing',
  'volatility.edge',
  'option.select',
  'rank.composite',
  'size.position',
  'explain.narrative',
] as const;

const GROUP_BY_SKILL: Record<string, string> = {
  'market.regime': 'Market',
  'technical.timing': 'Timing',
  'volatility.edge': 'Volatility',
  'option.select': 'Option',
  'rank.composite': 'Rank',
  'size.position': 'Sizing',
};

export function groupOf(skillId: string, rule: string): string {
  if (rule.startsWith('data.stale')) return 'Freshness';
  if (skillId === 'fundamental.gate') return rule.startsWith('events.') ? 'Events' : 'Quality gate';
  return GROUP_BY_SKILL[skillId] ?? 'Other';
}

export function reasonView(r: Reason, skillId: string): ReasonView {
  return {
    rule: r.rule,
    value: r.value,
    threshold: r.threshold ?? null,
    level: r.level ?? (r.passed ? 'PASS' : 'WARN'),
    kind: r.kind ?? null,
    note: r.note ?? null,
    group: groupOf(skillId, r.rule),
    skillId,
  };
}

export function reasonViews(results: Record<string, SkillResult>): ReasonView[] {
  const out: ReasonView[] = [];
  for (const id of SKILL_ORDER) {
    const res = results[id];
    if (!res || id === 'explain.narrative') continue;
    for (const r of res.reasons) out.push(reasonView(r, id));
  }
  return out;
}

export function skillRows(results: Record<string, SkillResult>): SkillRowView[] {
  const out: SkillRowView[] = [];
  for (const id of SKILL_ORDER) {
    const res = results[id];
    if (!res) continue;
    out.push({
      skillId: res.skillId,
      version: res.version,
      verdict: res.verdict,
      score: res.score,
      tier: res.dataQuality.tier,
      missing: res.dataQuality.missing,
    });
  }
  return out;
}

const payloadOf = <T>(n: NameResult, id: string): T | undefined => n.results[id]?.payload as T | undefined;

export function contractView(c: ContractChoice, s4: OptionSelectPayload, inst: Instrument): ContractView {
  return {
    expiry: c.expiry,
    dte: c.dte,
    strike: c.strike,
    delta: c.delta,
    premium: inst.multiplier > 0 ? c.credit / inst.multiplier : c.fillPrice,
    multiplier: inst.multiplier,
    credit: c.credit,
    collateral: c.collateral,
    collateralBase: c.collateralBaseCcy,
    annRocPct: c.annRoc * 100,
    rocPct: c.roc * 100,
    cushionPct: c.cushionPct * 100,
    breakeven: c.breakeven,
    probItm: c.probItm,
    expectedValue: c.expectedValue,
    bid: c.bid,
    ask: c.ask,
    iv: c.iv,
    priceSource: s4.source ?? 'synthetic',
    tier: s4.tier ?? 'proxy',
  };
}

export function sizingView(s6: SizingPayload | undefined): SizingView | null {
  if (!s6) return null;
  return {
    contracts: s6.contracts,
    collateralBase: s6.collateralBaseCcy,
    pctOfEquity: s6.pctOfEquity * 100,
    capsHit: s6.capsHit,
    sizeFactor: s6.sizeFactor,
  };
}

export function regimeView(market: 'US' | 'HK', p: RegimePayload): RegimeView {
  const label = p.regime.replace(/_/g, '-');
  const note =
    p.indexVsSma200Pct === null
      ? `${p.indexSymbol} has no 200-day average yet`
      : `${p.indexSymbol} is ${Math.abs(p.indexVsSma200Pct).toFixed(1)}% ${p.indexVsSma200Pct >= 0 ? 'above' : 'below'} its 200-day average${
          p.usedVolIndex && p.volIndex !== null
            ? `, vol index ${p.volIndex.toFixed(1)}`
            : '; no vol index (regime.noVolIndex)'
        }`;
  return {
    market,
    regime: p.regime,
    label,
    deployCapPct: p.deployCapPct * 100,
    deltaCap: p.deltaCap,
    note,
    usedVolIndex: p.usedVolIndex,
  };
}

export function narrativeView(n: NameResult): { headline: string; lines: string[] } | null {
  const s7 = payloadOf<NarrativePayload>(n, 'explain.narrative');
  return s7 ? { headline: s7.headline, lines: s7.lines } : null;
}

export function ideaView(n: NameResult): IdeaView | null {
  const inst = n.instrument;
  const s4 = payloadOf<OptionSelectPayload>(n, 'option.select');
  const s5 = payloadOf<CompositePayload>(n, 'rank.composite');
  const s2 = payloadOf<TechnicalPayload>(n, 'technical.timing');
  const c = s4?.chosen;
  if (!c || !s4 || !s5 || n.composite === null || n.rank === null) return null;
  return {
    symbol: inst.symbol,
    market: inst.market,
    name: inst.name,
    sector: inst.sector,
    currency: inst.currency,
    rank: n.rank,
    composite: n.composite,
    confidence: s5.confidence,
    tier: n.results['rank.composite']?.dataQuality.tier ?? 'proxy',
    staleTagged: n.staleTagged,
    spot: s4.spot ?? s2?.close ?? 0,
    support: s2?.support ?? s4.support,
    supportSource: s2?.supportSource ?? null,
    trend: s2?.trendState ?? null,
    contract: contractView(c, s4, inst),
    sizing: sizingView(payloadOf<SizingPayload>(n, 'size.position')),
    ruleWarns: s5.ruleWarns,
    narrative: narrativeView(n),
    reasons: reasonViews(n.results),
    skills: skillRows(n.results),
    nextEarnings: null,
    value: null,
  };
}

function bindingDetail(n: NameResult): { rule: string; detail: string; skillId: string | null } {
  const b = n.binding;
  if (b) {
    const r = b.reason;
    const detail =
      r.note ??
      [r.value === null ? null : String(r.value), r.threshold ? `want ${r.threshold}` : null]
        .filter(Boolean)
        .join(' | ');
    return { rule: r.rule, detail, skillId: b.skillId };
  }
  if (n.cutReason) return { rule: 'runner.cut', detail: n.cutReason, skillId: null };
  return { rule: n.status, detail: n.status, skillId: null };
}

export function rejectView(n: NameResult): RejectView {
  const inst = n.instrument;
  const b = bindingDetail(n);
  const barsStale = n.stale.find((s) => s.input === 'bars');
  return {
    symbol: inst.symbol,
    market: inst.market,
    name: inst.name,
    sector: inst.sector,
    status: n.status as RejectStatus,
    bindingRule: b.rule,
    detail: b.detail,
    skillId: b.skillId,
    staleLastBar: barsStale?.actual ?? null,
    reasons: reasonViews(n.results),
    skills: skillRows(n.results),
    value: null,
  };
}

/** A name that never had a price bar cannot be scored: it waits for its first ingest instead of being "rejected". */
export function isWaitingForData(n: NameResult): boolean {
  return n.status === 'dropped_stale' && n.stale.some((s) => s.input === 'bars' && s.actual === null);
}

export function openNameView(n: NameResult, contracts: number): OpenNameView {
  return { symbol: n.instrument.symbol, market: n.instrument.market, name: n.instrument.name, contracts };
}

export function firstRegime(names: NameResult[], market: 'US' | 'HK'): RegimeView | null {
  for (const n of names) {
    if (n.instrument.market !== market) continue;
    const p = payloadOf<RegimePayload>(n, 'market.regime');
    if (p) return regimeView(market, p);
  }
  return null;
}

export const isoDay = (d: Date): ISODate => d.toISOString().slice(0, 10);
