/**
 * S6 size.position (docs/01 G, docs/04 S6): how many contracts. Sized on full NOTIONAL (strike x multiplier, in base
 * currency), never on broker margin. Never cached (depends on equity and open collateral).
 *   budget    = min(per-name cap, remaining regime deployment cap) x size factors
 *   contracts = floor(budget / collateralBase)
 * `ctx.portfolio.committedBase` / `committedBySector` carry what better-ranked names in this same scan already consumed,
 * so the regime cap and the sector limit hold across the shortlist, not per name in isolation.
 */

import { type GovernorDecision, governorDecision, type PnlSummary, summarisePnl } from '../core/governor';
import type { DegearTier, Reason } from '../core/types';
import { round } from '../core/util';
import { type AnalysisSkill, fail, info, pass, type SkillResult, warnData, warnRule } from './contract';
import { fmt, pctStr } from './helpers';
import type { RegimePayload } from './s0-market-regime';
import type { FundamentalPayload } from './s1-fundamental-gate';
import type { TechnicalPayload } from './s2-technical-timing';
import type { OptionSelectPayload } from './s4-option-select';

export interface SizingPayload {
  contracts: number;
  collateral: number;
  collateralBaseCcy: number;
  pctOfEquity: number;
  kellySuggested: number | null;
  capsHit: string[];
  perNameCapBase: number | null;
  regimeRemainingBase: number | null;
  sizeFactor: number;
  /** The drawdown governor's reading on asOf (trade-skills T3); null when sizing stopped before it was read. */
  governor: GovernorView | null;
}

export interface GovernorView {
  dayPnl: number;
  drawdownPct: number | null;
  consecutiveLosses: number;
  multiplier: number;
  tier: DegearTier | null;
  halt: GovernorDecision['halt'];
}

function governorView(pnl: PnlSummary, g: GovernorDecision): GovernorView {
  return {
    dayPnl: round(pnl.dayPnl, 2),
    drawdownPct: pnl.drawdownPct === null ? null : round(pnl.drawdownPct, 2),
    consecutiveLosses: pnl.consecutiveLosses,
    multiplier: g.multiplier,
    tier: g.tier,
    halt: g.halt,
  };
}

const ZERO: SizingPayload = {
  contracts: 0,
  collateral: 0,
  collateralBaseCcy: 0,
  pctOfEquity: 0,
  kellySuggested: null,
  capsHit: [],
  perNameCapBase: null,
  regimeRemainingBase: null,
  sizeFactor: 1,
  governor: null,
};

export const sizePosition: AnalysisSkill<SizingPayload> = {
  id: 'size.position',
  version: '1.1.0',
  dependsOn: ['market.regime', 'rank.composite'],
  paramKey: 'size.position',
  cacheable: false,

  async run(ctx): Promise<SkillResult<SizingPayload>> {
    const p = ctx.params['size.position'];
    const reasons: Reason[] = [];
    const res = (payload: SizingPayload, verdict: SkillResult['verdict']): SkillResult<SizingPayload> => ({
      skillId: this.id,
      version: this.version,
      score: null,
      verdict,
      reasons,
      payload,
      dataQuality: { tier: 'real', missing: [] },
    });

    const equity = ctx.portfolio.equity;
    const s0 = ctx.data.priorSkillResult<RegimePayload>('market.regime')?.payload;
    const s1 = ctx.data.priorSkillResult<FundamentalPayload>('fundamental.gate')?.payload;
    const s2 = ctx.data.priorSkillResult('technical.timing') as SkillResult<TechnicalPayload> | undefined;
    const chosen = ctx.data.priorSkillResult<OptionSelectPayload>('option.select')?.payload.chosen ?? null;

    if (equity === null) {
      reasons.push(
        fail('size.noEquity', true, { note: 'equity is not set: `settings set equity <amount> --base HKD`' }),
      );
      return res({ ...ZERO }, 'FAIL');
    }
    if (!chosen) {
      reasons.push(info('size.noContract', true, { note: 'no contract selected: nothing to size' }));
      return res({ ...ZERO }, 'NA');
    }
    if (chosen.collateralBaseCcy === null) {
      reasons.push(
        warnData('size.noFx', ctx.instrument.currency, {
          note: `no ${ctx.instrument.currency}->${ctx.portfolio.baseCurrency} FX rate: cannot size in base currency`,
        }),
      );
      return res({ ...ZERO, collateral: chosen.collateral }, 'WARN');
    }
    const oneBase = chosen.collateralBaseCcy;

    // ------------------------------------------------- drawdown governor (T3, pitfall 31): portfolio-wide, as of today
    const settings = ctx.portfolio.governor;
    const pnl = summarisePnl(await ctx.data.ledger(), ctx.asOf, equity, ctx.portfolio.fxToBase);
    const gov = governorDecision(pnl, settings);
    const governorOn =
      settings !== undefined &&
      (settings.dailyLossLimit !== null || settings.consecutiveLossHalt !== null || settings.degearTiers.length > 0);
    if (governorOn && pnl.skippedCurrencies.length > 0) {
      reasons.push(
        warnData('size.governorFx', pnl.skippedCurrencies.join(', '), {
          note: `no FX rate to ${ctx.portfolio.baseCurrency} for puts in ${pnl.skippedCurrencies.join(', ')}: they are left out of the day P&L and the drawdown`,
        }),
      );
    }
    if (gov.halt) {
      reasons.push(
        fail('size.dailyLossHalt', gov.halt.kind, {
          threshold:
            gov.halt.kind === 'dailyLoss'
              ? `day P&L above -${fmt(settings?.dailyLossLimit ?? 0, 0)} ${ctx.portfolio.baseCurrency}`
              : `fewer than ${settings?.consecutiveLossHalt ?? 0} losing closes in a row`,
          note: `${gov.halt.detail}: no new puts today`,
        }),
      );
      return res({ ...ZERO, collateral: 0, sizeFactor: 0, governor: governorView(pnl, gov) }, 'FAIL');
    }

    // ------------------------------------------------- budgets in base currency
    const namePct = ctx.maxCollateralPct ?? p.maxPerNamePct;
    const perNameCap = namePct * equity;
    const regimeCapTotal = (s0?.deployCapPct ?? 0.3) * equity;
    const openBase = ctx.portfolio.openPositions
      .filter((o) => o.market === ctx.instrument.market)
      .reduce((a, o) => {
        const fx = ctx.portfolio.fxToBase(o.currency);
        return a + (fx === null ? 0 : o.strike * o.multiplier * o.quantity * fx);
      }, 0);
    const committed = ctx.portfolio.committedBase ?? 0;
    const regimeRemaining = Math.max(0, regimeCapTotal - openBase - committed);

    const factors: string[] = [];
    let factor = 1;
    if (s2?.reasons.some((r) => r.rule === 'trend.belowSma200')) {
      factor *= p.belowSma200Factor;
      factors.push(`below SMA200 x${p.belowSma200Factor}`);
    }
    if (s1?.earningsInWindow && ctx.params['fundamental.gate'].allowEarningsInWindow) {
      factor *= p.earningsHalfSize;
      factors.push(`earnings in window x${p.earningsHalfSize}`);
    }
    if (factors.length) reasons.push(warnRule('size.reducedSize', fmt(factor, 2), { note: factors.join(', ') }));
    if (gov.tier) {
      factor *= gov.multiplier;
      reasons.push(
        warnRule('size.drawdownTier', `${fmt(pnl.drawdownPct, 1)}%`, {
          threshold: `drawdown under ${fmt(gov.tier.drawdownPct, 1)}% of equity from the P&L peak`,
          note: `drawdown ${fmt(pnl.drawdownPct, 1)}% of equity (${fmt(pnl.drawdown, 0)} ${ctx.portfolio.baseCurrency} under the peak) is past the ${fmt(gov.tier.drawdownPct, 1)}% tier: size x${fmt(gov.multiplier, 2)}`,
        }),
      );
    }

    // ------------------------------------------------- caps
    const capsHit: string[] = [];
    const byName = Math.floor((perNameCap * factor) / oneBase);
    const byRegime = Math.floor((regimeRemaining * factor) / oneBase);
    if (gov.tier && gov.multiplier === 0) capsHit.push('drawdownTier');
    const sector = ctx.instrument.sector;
    const sectorCount =
      ctx.portfolio.openPositions.filter((o) => o.sector === sector && o.instrumentId !== ctx.instrument.id).length +
      (sector ? (ctx.portfolio.committedBySector?.[sector] ?? 0) : 0);
    const sectorBlocked = !!sector && sectorCount >= p.maxSectorOpen;
    if (sectorBlocked) capsHit.push('sectorCap');
    if (factor > 0 && byName <= byRegime && byName < Infinity) capsHit.push('perNameCap');
    if (factor > 0 && byRegime <= byName) capsHit.push('regimeCap');

    let contracts = Math.max(0, Math.min(byName, byRegime));
    if (sectorBlocked) contracts = 0;
    const uniqueCaps = [...new Set(capsHit)];

    reasons.push(
      byName >= 1
        ? pass('size.perNameCap', pctStr(namePct, 1), {
            note: `${fmt(perNameCap, 0)} ${ctx.portfolio.baseCurrency} per name; one contract is ${fmt(oneBase, 0)}`,
          })
        : fail('size.perNameCap', pctStr(namePct, 1), {
            note: `one contract is ${fmt(oneBase, 0)} ${ctx.portfolio.baseCurrency} of notional, above the ${fmt(perNameCap * factor, 0)} per-name budget`,
          }),
      byRegime >= 1
        ? pass('size.regimeCap', pctStr(s0?.deployCapPct ?? 0.3, 0), {
            note: `${fmt(regimeRemaining, 0)} left of ${fmt(regimeCapTotal, 0)} (open ${fmt(openBase, 0)}, committed this scan ${fmt(committed, 0)})`,
          })
        : fail('size.regimeCap', pctStr(s0?.deployCapPct ?? 0.3, 0), {
            note: `deployment cap used up: ${fmt(regimeRemaining, 0)} left`,
          }),
      sectorBlocked
        ? fail('size.sectorCap', sectorCount, { threshold: `< ${p.maxSectorOpen} open puts in ${sector}` })
        : pass('size.sectorCap', sectorCount, { threshold: `< ${p.maxSectorOpen} open puts per sector` }),
    );

    const collateral = contracts * chosen.collateral;
    return res(
      {
        contracts,
        collateral,
        collateralBaseCcy: contracts * oneBase,
        pctOfEquity: equity > 0 ? (contracts * oneBase) / equity : 0,
        kellySuggested: null,
        capsHit: contracts === 0 ? uniqueCaps : [],
        perNameCapBase: round(perNameCap, 2),
        regimeRemainingBase: round(regimeRemaining, 2),
        sizeFactor: factor,
        governor: governorView(pnl, gov),
      },
      contracts > 0 ? 'PASS' : 'WARN',
    );
  },
};
