/**
 * S5 rank.composite (docs/01 F, docs/04 S5).
 *
 * composite = sum(weight x score) over the skills that produced a score, weights renormalised to 1 (an unscored S3
 * rvOnly tier just drops out), times 0.85 when any RULE-based warning exists (a threshold in the warn band, close below
 * SMA200, relaxed support) but NOT for data-quality warnings (partial coverage, unknown earnings date, estimated filing
 * date, proxy IV): otherwise nearly every HK name would be penalised for its data source rather than the stock.
 * Never cached: the open-position exclusion depends on portfolio state that changes without any data write.
 */

import type { Reason } from '../core/types';
import { clamp, round } from '../core/util';
import {
  type AnalysisSkill,
  bindingReason,
  fail,
  hasRuleWarn,
  info,
  pass,
  type SkillResult,
  warnRule,
} from './contract';
import { fmt } from './helpers';
import type { RegimePayload } from './s0-market-regime';
import type { FundamentalPayload } from './s1-fundamental-gate';
import type { TechnicalPayload } from './s2-technical-timing';
import type { VolatilityPayload } from './s3-volatility-edge';
import type { OptionSelectPayload } from './s4-option-select';

export interface BacktestCard {
  n: number;
  winRate: number;
  avgRoc: number;
  source: 'journal' | 'backtest';
}

export interface CompositePayload {
  composite: number | null;
  confidence: number | null;
  backtestCard: BacktestCard | null;
  scores: { fundamental: number | null; technical: number | null; vol: number | null; option: number | null };
  weightsUsed: Record<string, number>;
  multiplier: number;
  ruleWarns: string[];
  convictionBonus: number;
  excluded: 'alreadyOpen' | null;
  failedAt: string | null;
}

export const rankComposite: AnalysisSkill<CompositePayload> = {
  id: 'rank.composite',
  version: '1.0.0',
  dependsOn: ['market.regime', 'fundamental.gate', 'technical.timing', 'volatility.edge', 'option.select'],
  paramKey: 'rank.composite',
  cacheable: false,

  async run(ctx): Promise<SkillResult<CompositePayload>> {
    const p = ctx.params['rank.composite'];
    const gateP = ctx.params['fundamental.gate'];
    const reasons: Reason[] = [];
    const get = <T>(id: string) => ctx.data.priorSkillResult<T>(id);
    const s0 = get<RegimePayload>('market.regime');
    const s1 = get<FundamentalPayload>('fundamental.gate');
    const s2 = get<TechnicalPayload>('technical.timing');
    const s3 = get<VolatilityPayload>('volatility.edge');
    const s4 = get<OptionSelectPayload>('option.select');
    const upstream = ([s0, s1, s2, s3, s4] as (SkillResult | undefined)[]).filter((x): x is SkillResult => !!x);

    // ------------------------------------------------ binding failure from upstream
    let failedAt: string | null = null;
    for (const r of upstream) {
      const b = bindingReason(r);
      if (b) {
        failedAt = r.skillId;
        reasons.push(
          fail(b.rule, b.value, {
            ...(b.threshold ? { threshold: b.threshold } : {}),
            note: `${r.skillId}${b.note ? `: ${b.note}` : ''}`,
          }),
        );
        break;
      }
    }

    // Earnings allowed inside the window only with a rich IV rank (docs/01 A5); S6 halves the size.
    if (!failedAt && s1?.payload.earningsInWindow && gateP.allowEarningsInWindow) {
      const ivr = s3?.payload.ivRank ?? null;
      if (ivr === null || ivr < gateP.earningsIvrOverride) {
        failedAt = 'fundamental.gate';
        reasons.push(
          fail('events.earningsNeedsIvr', ivr === null ? 'n/a' : fmt(ivr, 0), {
            threshold: `IV rank >= ${gateP.earningsIvrOverride} when earnings fall in the window`,
          }),
        );
      } else {
        reasons.push(
          pass('events.earningsNeedsIvr', fmt(ivr, 0), {
            threshold: `>= ${gateP.earningsIvrOverride}`,
            note: 'earnings inside the window allowed at half size',
          }),
        );
      }
    }

    // ------------------------------------------------ option score
    const chosen = s4?.payload.chosen ?? null;
    const optionScore = chosen
      ? round(clamp(chosen.annRoc / p.targetAnnRoc, 0, 1.5) * 60 + clamp(chosen.cushionPct / 0.1, 0, 1) * 40, 1)
      : null;
    const scores = {
      fundamental: s1?.score ?? null,
      technical: s2?.score ?? null,
      vol: s3?.score ?? null,
      option: optionScore,
    };

    // ------------------------------------------------ composite with renormalised weights
    let wsum = 0;
    let acc = 0;
    const weightsUsed: Record<string, number> = {};
    for (const k of ['fundamental', 'technical', 'vol', 'option'] as const) {
      const s = scores[k];
      if (s === null) continue;
      wsum += p.weights[k];
      acc += p.weights[k] * s;
    }
    for (const k of ['fundamental', 'technical', 'vol', 'option'] as const) {
      if (scores[k] !== null) weightsUsed[k] = round(p.weights[k] / wsum, 4);
    }
    const ruleWarns = upstream
      .flatMap((r) => r.reasons.filter((x) => x.level === 'WARN' && x.kind !== 'data').map((x) => x.rule))
      .filter((rule, i, a) => a.indexOf(rule) === i);
    const multiplier = ruleWarns.length > 0 ? p.warnMultiplier : 1;
    const convictionBonus = ctx.conviction ? p.convictionWeight * ctx.conviction * 20 : 0;
    const composite = wsum > 0 ? round(clamp((acc / wsum) * multiplier + convictionBonus, 0, 100), 1) : null;
    if (s3 && s3.score === null && s3.verdict === 'NA') {
      reasons.push(
        info('rank.weightsRenormalised', Object.keys(weightsUsed).join('+'), {
          note: 'volatility.edge produced no score (iv.unscored): weights renormalised over the skills that did',
        }),
      );
    }
    if (ruleWarns.length > 0) {
      reasons.push(
        warnRule('rank.warnMultiplier', p.warnMultiplier, { note: `rule-based warning(s): ${ruleWarns.join(', ')}` }),
      );
    }
    if (upstream.some((r) => hasRuleWarn(r) === false && r.reasons.some((x) => x.level === 'WARN'))) {
      reasons.push(
        info('rank.dataWarningsNotPenalised', true, {
          note: 'data-quality warnings are shown but do not reduce the composite',
        }),
      );
    }
    if (convictionBonus > 0)
      reasons.push(info('rank.conviction', ctx.conviction, { note: `+${fmt(convictionBonus, 1)} points` }));

    // ------------------------------------------------ open-position exclusion
    const open = ctx.portfolio.openPositions.filter((o) => o.instrumentId === ctx.instrument.id);
    let excluded: CompositePayload['excluded'] = null;
    if (open.length > 0) {
      excluded = 'alreadyOpen';
      reasons.push({
        rule: 'portfolio.alreadyOpen',
        value: open.length,
        passed: false,
        level: 'INFO',
        note: `open put ${open.map((o) => `${o.quantity} x ${o.strike} ${o.expiry}`).join(', ')}: never recommended again while open (explain still shows the scores)`,
      });
    }

    // ------------------------------------------------ journal-derived card (no backtest engine yet)
    const outcomes = await ctx.data.journal();
    const backtestCard: BacktestCard | null =
      outcomes.length > 0
        ? {
            n: outcomes.length,
            winRate: outcomes.filter((o) => o.pnl > 0).length / outcomes.length,
            avgRoc: outcomes.reduce((a, o) => a + (o.collateral > 0 ? o.pnl / o.collateral : 0), 0) / outcomes.length,
            source: 'journal',
          }
        : null;

    const verdict = failedAt
      ? 'FAIL'
      : excluded
        ? 'NA'
        : ruleWarns.length > 0
          ? 'WARN'
          : composite === null
            ? 'NA'
            : 'PASS';
    return {
      skillId: this.id,
      version: this.version,
      score: composite,
      verdict,
      reasons,
      payload: {
        composite,
        confidence: null,
        backtestCard,
        scores,
        weightsUsed,
        multiplier,
        ruleWarns,
        convictionBonus,
        excluded,
        failedAt,
      },
      dataQuality: {
        tier: upstream.some((r) => r.dataQuality.tier === 'synthetic')
          ? 'synthetic'
          : upstream.some((r) => r.dataQuality.tier === 'proxy')
            ? 'proxy'
            : 'real',
        missing: [...new Set(upstream.flatMap((r) => r.dataQuality.missing))],
      },
    };
  },
};
