/**
 * S4 option.select (docs/01 section E, docs/04 S4): which contract to sell.
 *
 * Constraints are applied in a fixed order (delta band -> support -> bid -> spread -> open interest -> annualised ROC).
 * When nothing survives, the binding constraint is the stage at which the survivor set became empty, so every FAIL
 * names its rule. A real chain is used when one is fresh enough; otherwise, if allowed, strikes are priced
 * synthetically from IV30 with a skew bump and haircuts (or the chain-calibrated real/synthetic ratio per delta bucket).
 * Greeks missing from the quote are computed from its IV (or from an IV implied from the mid) and labelled
 * `greeks:computed`.
 */

import { expiriesBetween, hkMonthlyExpiry, usMonthlyExpiry } from '../core/calendar';
import { deltaBucket, priceTick, riskFreeFor, strikeIncrement, YEAR_DAYS } from '../core/contracts';
import { addDays, diffDays, type ISODate, monthOf, yearOf } from '../core/dates';
import type { ChainSource, DataTier, OptionChainSnapshot, Reason } from '../core/types';
import { round } from '../core/util';
import { bsGreeks, bsPrice, expectedPutLossGivenItm, probItm, probTouchApprox, quoteIv } from '../indicators';
import {
  type AnalysisSkill,
  fail,
  info,
  pass,
  type SkillContext,
  type SkillResult,
  warnData,
  warnRule,
} from './contract';
import { fmt, pctStr } from './helpers';
import type { RegimePayload } from './s0-market-regime';
import type { TechnicalPayload } from './s2-technical-timing';
import type { VolatilityPayload } from './s3-volatility-edge';

export interface ContractChoice {
  contractId: 'chain' | 'synthetic';
  strike: number;
  expiry: ISODate;
  dte: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  /** Per-share fill price used for the credit (bid, or mid minus a tick; synthetic: haircut model price). */
  fillPrice: number;
  delta: number;
  iv: number | null;
  oi: number | null;
  spreadPct: number | null;
  credit: number;
  collateral: number;
  collateralBaseCcy: number | null;
  marginEstimate: number | null;
  rocOnMargin: number | null;
  roc: number;
  annRoc: number;
  breakeven: number;
  cushionPct: number;
  probItm: number;
  probTouch: number;
  bsProbItm: number | null;
  expectedValue: number | null;
  /** P(S_T < breakeven) under the IV being sold (the contract's IV), lognormal. */
  lossProbIv: number | null;
  /** The same probability under the realised vol of the most recent completed window (S3 `rvRecent`). */
  lossProbRv: number | null;
  greeksSource: 'quote' | 'computed' | 'model';
}

export interface OptionSelectPayload {
  chosen: ContractChoice | null;
  alternative: ContractChoice | null;
  rejected: { strike: number; expiry: ISODate; reason: string }[];
  tier: DataTier | null;
  source: ChainSource | 'synthetic' | null;
  expiry: ISODate | null;
  spot: number | null;
  support: number | null;
  deltaMaxEffective: number | null;
  binding: string | null;
  relaxedSupport: boolean;
  considered: number;
}

interface Cand {
  strike: number;
  expiry: ISODate;
  dte: number;
  t: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  fillPrice: number;
  delta: number | null;
  iv: number | null;
  oi: number | null;
  spreadPct: number | null;
  greeksSource: ContractChoice['greeksSource'];
  synthetic: boolean;
}

const STAGES = [
  'delta.band',
  'support',
  'liquidity.bid',
  'liquidity.spread',
  'liquidity.oi',
  'roc.annualized',
] as const;
type Stage = (typeof STAGES)[number];

const EMPTY_PAYLOAD: OptionSelectPayload = {
  chosen: null,
  alternative: null,
  rejected: [],
  tier: null,
  source: null,
  expiry: null,
  spot: null,
  support: null,
  deltaMaxEffective: null,
  binding: null,
  relaxedSupport: false,
  considered: 0,
};

/** The expiry days a new put may use in the DTE window (HK: the single monthly; US: Fridays). */
export function targetExpiries(market: 'US' | 'HK', asOf: ISODate, dteMin: number, dteMax: number): ISODate[] {
  if (market === 'HK') {
    let y = yearOf(asOf);
    let m = monthOf(asOf);
    let e = hkMonthlyExpiry(y, m);
    if (diffDays(e, asOf) < dteMin) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      e = hkMonthlyExpiry(y, m);
    }
    const d = diffDays(e, asOf);
    return d >= dteMin && d <= dteMax ? [e] : [];
  }
  return expiriesBetween('US', addDays(asOf, dteMin), addDays(asOf, dteMax));
}

function isMonthlyUs(expiry: ISODate): boolean {
  return usMonthlyExpiry(yearOf(expiry), monthOf(expiry)) === expiry;
}

export const optionSelect: AnalysisSkill<OptionSelectPayload> = {
  id: 'option.select',
  version: '1.2.0',
  dependsOn: ['market.regime', 'fundamental.gate', 'technical.timing', 'volatility.edge'],
  paramKey: 'option.select',
  cacheable: true,

  async run(ctx: SkillContext): Promise<SkillResult<OptionSelectPayload>> {
    const p = ctx.params['option.select'];
    const inst = ctx.instrument;
    const mkt = inst.market;
    const rf = riskFreeFor(mkt, p.riskFreeUS, p.riskFreeHK);
    const reasons: Reason[] = [];
    const missing: string[] = [];

    const s0 = ctx.data.priorSkillResult<RegimePayload>('market.regime')?.payload;
    const s2 = ctx.data.priorSkillResult<TechnicalPayload>('technical.timing')?.payload;
    const s3 = ctx.data.priorSkillResult<VolatilityPayload>('volatility.edge')?.payload;
    const bars = await ctx.data.bars(1);
    const spot = bars[bars.length - 1]?.close ?? null;
    const base = (extra: Partial<OptionSelectPayload> = {}): OptionSelectPayload => ({
      ...EMPTY_PAYLOAD,
      spot,
      ...extra,
    });
    const done = (
      verdict: SkillResult['verdict'],
      payload: OptionSelectPayload,
      tier: DataTier,
    ): SkillResult<OptionSelectPayload> => ({
      skillId: this.id,
      version: this.version,
      score: null,
      verdict,
      reasons,
      payload,
      dataQuality: { tier, missing },
    });

    if (spot === null) {
      reasons.push(fail('option.noPrice', true, { note: 'no price bar on or before asOf' }));
      return done('FAIL', base(), 'proxy');
    }

    const dteMin = p.dteMin[mkt];
    const dteMax = p.dteMax[mkt];
    const minAnnRoc = p.minAnnRoc[mkt];
    const maxSpread = p.maxSpreadPct[mkt];
    const minOI = p.minOI[mkt];
    const deltaCap = s0?.deltaCap ?? p.deltaMax;
    const deltaMaxEff = Math.min(p.deltaMax, deltaCap);
    const support = s2?.support ?? null;
    const baseCcy = ctx.portfolio.baseCurrency;
    const fxToBase = await ctx.data.fx(inst.currency, baseCcy);
    if (fxToBase === null) missing.push('fx');

    if (deltaMaxEff < p.deltaMin) {
      reasons.push(
        fail('delta.regimeCap', fmt(deltaCap), {
          threshold: `>= delta band floor ${p.deltaMin}`,
          note: `regime ${s0?.regime} caps |delta| below the band`,
        }),
      );
      return done('FAIL', base({ deltaMaxEffective: deltaMaxEff, binding: 'delta.regimeCap' }), 'real');
    }

    // --------------------------------------------------------------- candidates
    let targets = targetExpiries(mkt, ctx.asOf, dteMin, dteMax);
    // docs/01 A5, per candidate expiry: unless earnings inside the window are explicitly allowed, no expiry may reach the
    // next earnings date (S1 already failed names whose earnings precede every allowed expiry).
    const s1 = ctx.data.priorSkillResult<{ nextEarnings: string | null; earningsInWindow: boolean }>(
      'fundamental.gate',
    )?.payload;
    if (s1?.earningsInWindow && s1.nextEarnings && !ctx.params['fundamental.gate'].allowEarningsInWindow) {
      const before = targets.length;
      const cutoff = s1.nextEarnings;
      targets = targets.filter((e) => e < cutoff);
      if (before > 0 && targets.length === 0) {
        reasons.push(
          fail('events.earningsBeforeExpiry', cutoff, {
            threshold: 'expiry before the next earnings date',
            note: `every expiry in the ${dteMin}-${dteMax} day window reaches the earnings date ${cutoff}`,
          }),
        );
        return done('FAIL', base({ deltaMaxEffective: deltaMaxEff, binding: 'events.earningsBeforeExpiry' }), 'real');
      }
      reasons.push(
        info('option.earningsExpiries', cutoff, {
          note: `only expiries before the ${cutoff} earnings date are considered`,
        }),
      );
    }
    const chain = await ctx.data.chain();
    const usable = (c: OptionChainSnapshot): ISODate[] => {
      const have = new Set(c.quotes.filter((q) => q.right === 'P').map((q) => q.expiry));
      return targets.filter((e) => have.has(e));
    };
    const chainExpiries = chain ? usable(chain) : [];
    const useChain = !!chain && chainExpiries.length > 0;

    const calib = await ctx.data.calibration(ctx.params['volatility.edge'].calibrationMinSamples);
    const cands: Cand[] = [];
    let tier: DataTier = 'real';
    let source: ChainSource | 'synthetic' = chain?.source ?? 'synthetic';

    const fillOf = (bid: number | null, mid: number): number => {
      if (p.fillAssumption === 'bid') return bid ?? mid;
      return Math.max(bid ?? 0, mid - priceTick(mkt, mid));
    };

    if (useChain && chain) {
      for (const expiry of chainExpiries) {
        const dte = diffDays(expiry, ctx.asOf);
        const t = dte / YEAR_DAYS;
        for (const q of chain.quotes) {
          if (q.right !== 'P' || q.expiry !== expiry) continue;
          const mid = q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : (q.last ?? 0);
          const ivInfo = quoteIv(q, spot, t, rf);
          let delta: number | null = null;
          let gs: Cand['greeksSource'] = 'quote';
          if (q.delta !== null && Number.isFinite(q.delta)) delta = Math.abs(q.delta);
          else if (ivInfo) {
            delta = Math.abs(bsGreeks('P', spot, q.strike, t, rf, ivInfo.iv).delta);
            gs = 'computed';
          }
          cands.push({
            strike: q.strike,
            expiry,
            dte,
            t,
            bid: q.bid,
            ask: q.ask,
            mid,
            fillPrice: fillOf(q.bid, mid),
            delta,
            iv: ivInfo?.iv ?? q.iv,
            oi: q.openInterest,
            spreadPct: q.bid !== null && q.ask !== null && mid > 0 ? (q.ask - q.bid) / mid : null,
            greeksSource: gs,
            synthetic: false,
          });
        }
      }
      tier = chain.tier;
      source = chain.source;
      if (cands.some((c) => c.greeksSource === 'computed')) {
        reasons.push(
          info('option.greeks', 'greeks:computed', {
            note: `${chain.source} quotes carry no delta: Black-Scholes from quote IV (or IV implied from mid)`,
          }),
        );
      }
    } else if (p.allowSynthetic) {
      const sigma0 = s3?.iv30 ?? null;
      const expiry = mkt === 'HK' ? targets[0] : (targets.find(isMonthlyUs) ?? targets[Math.floor(targets.length / 2)]);
      if (!expiry) {
        reasons.push(
          fail('dte.window', `no ${mkt} expiry`, {
            threshold: `${dteMin}-${dteMax} days`,
            note: `no ${mkt} option expiry falls between ${dteMin} and ${dteMax} days from ${ctx.asOf}`,
          }),
        );
        return done('FAIL', base({ deltaMaxEffective: deltaMaxEff, binding: 'dte.window' }), 'synthetic');
      }
      if (sigma0 === null) {
        reasons.push(
          fail('option.noSynthetic', 'no IV estimate', { note: 'S3 produced no IV30 to price synthetic strikes' }),
        );
        return done('FAIL', base({ deltaMaxEffective: deltaMaxEff, binding: 'option.noSynthetic' }), 'synthetic');
      }
      const dte = diffDays(expiry, ctx.asOf);
      const t = dte / YEAR_DAYS;
      const inc = strikeIncrement(mkt, spot);
      const top = Math.floor(spot / inc) * inc;
      for (let j = 0; j <= p.syntheticStrikeSteps; j++) {
        const strike = Math.round((top - j * inc) * 1e6) / 1e6;
        if (strike <= 0) break;
        const d0 = Math.abs(bsGreeks('P', spot, strike, t, rf, sigma0).delta);
        const sigmaK = sigma0 + (p.skewBumpPer10Delta * Math.max(0, 0.5 - d0)) / 0.1;
        const delta = Math.abs(bsGreeks('P', spot, strike, t, rf, sigmaK).delta);
        const model = bsPrice('P', spot, strike, t, rf, sigmaK);
        const ratio = calib.priceRatio[deltaBucket(delta)]?.median;
        const mult = ratio ?? 1 - p.slippageHaircut[mkt] - p.modelRiskHaircut;
        cands.push({
          strike,
          expiry,
          dte,
          t,
          bid: null,
          ask: null,
          mid: model,
          fillPrice: model * mult,
          delta,
          iv: sigmaK,
          oi: null,
          spreadPct: null,
          greeksSource: 'model',
          synthetic: true,
        });
      }
      tier = 'synthetic';
      source = 'synthetic';
      const calibrated = Object.keys(calib.priceRatio).length > 0;
      reasons.push(
        warnData('option.synthetic', true, {
          note: `${chain ? `chain has no ${targets.join('/') || 'qualifying'} expiry; ` : 'no fresh chain; '}priced from IV30 ${pctStr(sigma0)} with a skew bump and ${calibrated ? 'chain-calibrated per-bucket ratios' : `${pctStr(p.slippageHaircut[mkt] + p.modelRiskHaircut, 0)} haircuts`}`,
        }),
      );
    } else {
      reasons.push(fail('option.noChain', true, { note: 'no fresh chain and allowSynthetic is off' }));
      return done('FAIL', base({ deltaMaxEffective: deltaMaxEff, binding: 'option.noChain' }), 'real');
    }

    // ------------------------------------------------------------ constraint pipeline
    const rejected: OptionSelectPayload['rejected'] = [];
    /** Annualised return on collateral per share: (fill / strike) x 365 / DTE (multiplier cancels). */
    const econ = (c: Cand): number => (c.fillPrice / c.strike) * (YEAR_DAYS / c.dte);
    const pipeline = (applySupport: boolean): { survivors: Cand[]; binding: Stage | null } => {
      let live = [...cands];
      for (const stage of STAGES) {
        if (stage === 'support' && !applySupport) continue;
        const keep: Cand[] = [];
        for (const c of live) {
          let why: string | null = null;
          switch (stage) {
            case 'delta.band':
              if (c.delta === null) why = 'delta.unknown';
              else if (c.delta < p.deltaMin || c.delta > deltaMaxEff)
                why = `delta.band (${fmt(c.delta)} outside ${p.deltaMin}-${fmt(deltaMaxEff)})`;
              break;
            case 'support':
              if (p.strikeBelowSupport && support !== null && c.strike > support)
                why = `support (strike above ${fmt(support)})`;
              break;
            case 'liquidity.bid':
              if (!c.synthetic && !(c.bid !== null && c.bid > 0)) why = 'liquidity.bid (no bid)';
              break;
            case 'liquidity.spread':
              if (!c.synthetic && (c.spreadPct === null || c.spreadPct > maxSpread))
                why = `liquidity.spread (${c.spreadPct === null ? 'n/a' : pctStr(c.spreadPct)} > ${pctStr(maxSpread, 0)})`;
              break;
            case 'liquidity.oi':
              if (!c.synthetic && c.oi !== null && c.oi < minOI) why = `liquidity.oi (${c.oi} < ${minOI})`;
              break;
            case 'roc.annualized':
              if (econ(c) < minAnnRoc) why = `roc.annualized (${pctStr(econ(c))} < ${pctStr(minAnnRoc, 0)})`;
              break;
          }
          if (why) rejected.push({ strike: c.strike, expiry: c.expiry, reason: why });
          else keep.push(c);
        }
        live = keep;
        if (live.length === 0) return { survivors: [], binding: stage };
      }
      return { survivors: live, binding: null };
    };

    let relaxed = false;
    let { survivors, binding } = pipeline(true);
    if (survivors.length === 0 && p.relaxSupport && p.strikeBelowSupport && support !== null) {
      const before = rejected.length;
      const retry = pipeline(false);
      if (retry.survivors.length > 0) {
        survivors = retry.survivors;
        binding = null;
        relaxed = true;
      } else {
        rejected.length = before;
      }
    }

    const capped = rejected.slice(0, 40);
    const stageNote: Record<Stage, string> = {
      'delta.band': `no put with |delta| in ${p.deltaMin}-${fmt(deltaMaxEff)}${deltaMaxEff < p.deltaMax ? ` (regime ${s0?.regime} cap)` : ''}`,
      support: `every remaining strike is above support ${fmt(support)}`,
      'liquidity.bid': 'every remaining put has no bid',
      'liquidity.spread': `every remaining put has a spread above ${pctStr(maxSpread, 0)}`,
      'liquidity.oi': `every remaining put has open interest below ${minOI}`,
      'roc.annualized': `no put earns ${pctStr(minAnnRoc, 0)} annualised on collateral`,
    };
    if (survivors.length === 0 && binding) {
      reasons.push(
        fail(binding === 'delta.band' ? 'delta.band' : binding, 'no contract satisfies all constraints', {
          note: stageNote[binding],
        }),
      );
      return done(
        'FAIL',
        base({
          tier,
          source,
          expiry: targets[0] ?? null,
          support,
          deltaMaxEffective: deltaMaxEff,
          binding,
          rejected: capped,
          considered: cands.length,
        }),
        tier,
      );
    }

    // ------------------------------------------------------------ choose and compute economics
    let pool = survivors;
    const expiriesLeft = [...new Set(pool.map((c) => c.expiry))];
    if (mkt === 'US' && expiriesLeft.length > 1) {
      const monthly = pool.filter((c) => isMonthlyUs(c.expiry));
      if (monthly.length > 0) pool = monthly; // two qualifying expiries: prefer the liquid monthly
    }
    const toChoice = (c: Cand): ContractChoice => {
      const collateral = c.strike * inst.multiplier;
      const credit = c.fillPrice * inst.multiplier;
      const roc = credit / collateral;
      const iv = c.iv;
      const bsP = iv !== null ? probItm('P', spot, c.strike, c.t, rf, iv) : null;
      const delta = c.delta as number;
      const margin =
        mkt === 'HK'
          ? p.hkMarginPctOfNotional * collateral
          : Math.max(0.2 * spot - Math.max(0, spot - c.strike), 0.1 * c.strike) * inst.multiplier + credit;
      const breakeven = c.strike - c.fillPrice;
      const ev =
        iv !== null && bsP !== null
          ? credit - bsP * expectedPutLossGivenItm(spot, c.strike, c.t, rf, iv) * inst.multiplier
          : null;
      // docs/designs/trade-skills-integration.md T1: the loss probability under both vols, side by side.
      const rvRecent = s3?.rvRecent ?? null;
      const lossProb = (sigma: number | null): number | null =>
        sigma !== null && sigma > 0 && breakeven > 0 ? probItm('P', spot, breakeven, c.t, rf, sigma) : null;
      return {
        contractId: c.synthetic ? 'synthetic' : 'chain',
        strike: c.strike,
        expiry: c.expiry,
        dte: c.dte,
        bid: c.bid,
        ask: c.ask,
        mid: c.mid,
        fillPrice: round(c.fillPrice, 6),
        delta,
        iv,
        oi: c.oi,
        spreadPct: c.spreadPct,
        credit: round(credit, 4),
        collateral,
        collateralBaseCcy: fxToBase === null ? null : collateral * fxToBase,
        marginEstimate: round(margin, 2),
        rocOnMargin: margin > 0 ? credit / margin : null,
        roc,
        annRoc: roc * (YEAR_DAYS / c.dte),
        breakeven: round(breakeven, 6),
        cushionPct: (spot - breakeven) / spot,
        probItm: delta,
        probTouch: probTouchApprox(delta),
        bsProbItm: bsP,
        expectedValue: ev === null ? null : round(ev, 4),
        lossProbIv: lossProb(iv),
        lossProbRv: lossProb(rvRecent),
        greeksSource: c.greeksSource,
      };
    };
    const ranked = pool
      .map((c) => ({ c, ch: toChoice(c) }))
      .sort((a, b) => b.ch.annRoc - a.ch.annRoc || b.c.strike - a.c.strike);
    const best = ranked[0] as (typeof ranked)[number];
    const alt = ranked
      .filter((x) => x.c.expiry === best.c.expiry && x.c.strike < best.c.strike)
      .sort((a, b) => b.c.strike - a.c.strike)[0];
    const chosen = best.ch;

    reasons.push(
      pass('option.delta', fmt(chosen.delta), {
        threshold: `${p.deltaMin}-${fmt(deltaMaxEff)}`,
        note: chosen.greeksSource === 'computed' ? 'greeks:computed' : chosen.greeksSource,
      }),
      pass('option.dte', chosen.dte, { threshold: `${dteMin}-${dteMax} days`, note: chosen.expiry }),
      support === null
        ? warnData('option.support', 'n/a', { note: 'no support level from S2: strike not constrained' })
        : relaxed
          ? warnRule('option.relaxedSupport', `strike ${fmt(chosen.strike)} > support ${fmt(support)}`, {
              note: 'relaxSupport param was needed to find a contract',
            })
          : pass('option.support', `strike ${fmt(chosen.strike)} <= support ${fmt(support)}`),
      pass('option.annRoc', pctStr(chosen.annRoc), {
        threshold: `>= ${pctStr(minAnnRoc, 0)}`,
        note: `${chosen.contractId === 'synthetic' ? 'synthetic' : source} price ${fmt(chosen.fillPrice, 3)} x ${inst.multiplier} = ${fmt(chosen.credit, 0)} on collateral ${fmt(chosen.collateral, 0)}`,
      }),
    );
    // The loss probability at the breakeven under both vols (T1): the IV being sold and the realised vol of the most
    // recent completed window. Two INFO rows the detail can show side by side; neither moves the verdict.
    if (chosen.lossProbIv !== null)
      reasons.push(
        info('option.lossProbIv', round(chosen.lossProbIv, 3), {
          note: `P(price below breakeven ${fmt(chosen.breakeven)} at expiry) at the IV sold, ${pctStr(chosen.iv)}`,
        }),
      );
    if (chosen.lossProbRv !== null)
      reasons.push(
        info('option.lossProbRv', round(chosen.lossProbRv, 3), {
          note: `the same at recent realised vol ${pctStr(s3?.rvRecent)} (last ${ctx.params['volatility.edge'].vrpWindowDays} trading days)${chosen.lossProbIv !== null ? `: ${chosen.lossProbRv > chosen.lossProbIv ? 'the market is pricing less risk than the stock has shown' : 'the market is pricing more risk than the stock has shown'}` : ''}`,
        }),
      );
    else
      reasons.push(
        info('option.lossProbRv', 'n/a', { note: 'no realised-vol window from S3: only the implied-vol probability' }),
      );
    if (chosen.spreadPct !== null)
      reasons.push(pass('liquidity.spread', pctStr(chosen.spreadPct), { threshold: `<= ${pctStr(maxSpread, 0)}` }));
    if (chosen.oi !== null) reasons.push(pass('liquidity.oi', chosen.oi, { threshold: `>= ${minOI}` }));
    else if (chosen.contractId === 'chain')
      reasons.push(
        warnData('liquidity.oiUnknown', true, { note: 'no open interest in the quote; liquidity.oi not tested' }),
      );
    if (fxToBase === null)
      reasons.push(
        warnData('fx.missing', `${inst.currency}->${baseCcy}`, {
          note: 'collateral in base currency unavailable: sizing is blocked',
        }),
      );

    return done(
      relaxed ? 'WARN' : 'PASS',
      {
        chosen,
        alternative: alt ? alt.ch : null,
        rejected: capped,
        tier,
        source,
        expiry: chosen.expiry,
        spot,
        support,
        deltaMaxEffective: deltaMaxEff,
        binding: null,
        relaxedSupport: relaxed,
        considered: cands.length,
      },
      tier,
    );
  },
};
