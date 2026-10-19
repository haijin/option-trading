/**
 * S7 explain.narrative: a deterministic template over the other skills' payloads and reasons. It adds no facts and
 * invents no numbers; anything missing prints as "n/a". Never cached (it embeds S5/S6).
 */
import type { Reason } from '../core/types';
import { type AnalysisSkill, bindingReason, type SkillResult } from './contract';
import { fmt, pctStr } from './helpers';
import type { RegimePayload } from './s0-market-regime';
import type { FundamentalPayload } from './s1-fundamental-gate';
import type { TechnicalPayload } from './s2-technical-timing';
import type { VolatilityPayload } from './s3-volatility-edge';
import type { OptionSelectPayload } from './s4-option-select';
import type { CompositePayload } from './s5-rank-composite';
import type { SizingPayload } from './s6-size-position';

export interface NarrativePayload {
  headline: string;
  lines: string[];
  text: string;
  reasons: (Reason & { skillId: string })[];
}

const SYMBOL: Record<string, string> = { HKD: 'HK$', USD: 'US$', SGD: 'S$' };
const money = (x: number | null | undefined, ccy: string, digits = 0): string =>
  x === null || x === undefined || !Number.isFinite(x)
    ? 'n/a'
    : `${SYMBOL[ccy] ?? `${ccy} `}${x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const explainNarrative: AnalysisSkill<NarrativePayload> = {
  id: 'explain.narrative',
  version: '1.0.0',
  dependsOn: [
    'market.regime',
    'fundamental.gate',
    'technical.timing',
    'volatility.edge',
    'option.select',
    'rank.composite',
    'size.position',
  ],
  paramKey: 'rank.composite',
  cacheable: false,

  async run(ctx): Promise<SkillResult<NarrativePayload>> {
    const inst = ctx.instrument;
    const ccy = inst.currency;
    const get = <T>(id: string) => ctx.data.priorSkillResult<T>(id);
    const s0 = get<RegimePayload>('market.regime');
    const s1 = get<FundamentalPayload>('fundamental.gate');
    const s2 = get<TechnicalPayload>('technical.timing');
    const s3 = get<VolatilityPayload>('volatility.edge');
    const s4 = get<OptionSelectPayload>('option.select');
    const s5 = get<CompositePayload>('rank.composite');
    const s6 = get<SizingPayload>('size.position');
    const all = ([s0, s1, s2, s3, s4, s5, s6] as (SkillResult | undefined)[]).filter((x): x is SkillResult => !!x);
    const lines: string[] = [];
    const c = s4?.payload.chosen ?? null;
    const label = `${inst.symbol}${inst.name ? ` ${inst.name}` : ''}`;

    let headline: string;
    if (c) {
      headline = `${label}: sell ${c.expiry.slice(0, 7)} Put ${fmt(c.strike, 2)} (delta ${fmt(c.delta)}, ${c.dte} DTE) for ${money(c.fillPrice, ccy, 2)} x ${inst.multiplier} = ${money(c.credit, ccy)}; collateral ${money(c.collateral, ccy)}; ${pctStr(c.annRoc)} annualised; breakeven ${fmt(c.breakeven, 2)} (${pctStr(-c.cushionPct)}).`;
    } else {
      const failed = [s0, s1, s2, s3, s4, s5].find((r) => r && bindingReason(r));
      const b = failed ? bindingReason(failed) : null;
      headline = `${label}: no put to sell${b ? `. Binding rule: ${b.rule}${b.note ? ` (${b.note})` : ''}` : ''}.`;
    }

    const f = s1?.payload;
    if (f) {
      const q: string[] = [];
      if (f.fScore !== null) q.push(`F-score ${f.fScore}/9`);
      if (f.zScore !== null) q.push(`Z ${fmt(f.zScore, 1)}`);
      if (f.gearing !== null) q.push(`net gearing ${pctStr(f.gearing, 0)}`);
      if (f.interestCover !== null) q.push(`interest cover ${fmt(f.interestCover, 1)}x`);
      if (f.fcfYield !== null) q.push(`FCF yield ${pctStr(f.fcfYield)}`);
      if (f.netDebtEbitda !== null)
        q.push(f.netDebtEbitda < 0 ? 'net cash' : `net debt/EBITDA ${fmt(f.netDebtEbitda, 1)}`);
      if (inst.solvencyModel === 'financial') q.push('solvency not tested (bank/insurer)');
      lines.push(
        `Quality: ${q.length ? q.join(', ') : 'n/a'}.${f.evEbitZ !== null ? ` Valuation: EV/EBIT ${fmt(f.evEbitZ, 1)} sigma vs its own history.` : ''}${f.skipped.length ? ` Not testable on free data: ${f.skipped.join(', ')}.` : ''}`,
      );
    }
    const t = s2?.payload;
    if (t && t.close !== null) {
      lines.push(
        `Timing: ${t.trendState ?? 'n/a'} trend (close ${fmt(t.close)}, SMA200 ${fmt(t.sma200)}), support ${fmt(t.support)} (${t.supportSource}), RSI ${fmt(t.rsi14, 0)}, 3m ${pctStr(t.ret3m)} vs index ${pctStr(t.indexRet3m)}.`,
      );
    }
    const v = s3?.payload;
    if (v && v.iv30 !== null) {
      lines.push(
        `Vol: IV30 ${pctStr(v.iv30)} (${v.ivSource}) vs realised ${pctStr(v.rv20)}${v.vrpRatio !== null ? ` (VRP ${fmt(v.vrpRatio, 2)})` : ''}, IV rank ${fmt(v.ivRank, 0)}${v.rankBasis && v.rankBasis !== 'real' ? ` on ${v.rankBasis} history` : ''}${v.tier === 'rvOnly' ? '; not scored (realised-vol only)' : ''}.`,
      );
    }
    if (f) {
      const sameWindow =
        c && f.nextEarnings ? (f.nextEarnings > c.expiry ? 'fall AFTER expiry' : 'fall BEFORE expiry') : '';
      lines.push(
        `Events: ${f.nextEarnings ? `results on ${f.nextEarnings} ${sameWindow}`.trim() : 'earnings date unknown'}.`,
      );
    }
    if (s0) {
      const r = s0.payload;
      lines.push(
        `Regime: ${inst.market} ${r.regime.replace('_', '-')} (deploy cap ${pctStr(r.deployCapPct, 0)}, delta <= ${fmt(r.deltaCap)}${r.usedVolIndex ? '' : '; no vol index'}).`,
      );
    }
    if (s6 && c) {
      const z = s6.payload;
      lines.push(
        z.contracts > 0
          ? `Size: ${z.contracts} contract(s), ${money(z.collateral, ccy)} notional (${pctStr(z.pctOfEquity)} of equity).`
          : `Size: 0 contracts (${s6.payload.capsHit.join(', ') || 'cap'}).`,
      );
    }
    if (s5?.payload.backtestCard) {
      const b = s5.payload.backtestCard;
      lines.push(
        `Your history on this name: ${b.n} closed trade(s), ${pctStr(b.winRate, 0)} win, average ${pctStr(b.avgRoc)} return on collateral (${b.source}, small sample).`,
      );
    }
    const tiers = all.map((r) => `${r.skillId.split('.')[0]}:${r.dataQuality.tier}`).join(' ');
    lines.push(`Data: ${tiers}${s4?.payload.source ? `; option prices ${s4.payload.source}` : ''}.`);

    const text = [`**${headline}**`, ...lines].join('\n');
    const merged = all.flatMap((r) => r.reasons.map((x) => ({ ...x, skillId: r.skillId })));
    return {
      skillId: this.id,
      version: this.version,
      score: null,
      verdict: 'NA',
      reasons: [],
      payload: { headline, lines, text, reasons: merged },
      dataQuality: { tier: 'real', missing: [] },
    };
  },
};
