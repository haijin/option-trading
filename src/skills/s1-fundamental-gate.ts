/**
 * S1 fundamental.gate (docs/01 section A, docs/04 S1): "would I be happy to own this at the strike?"
 *
 * Point-in-time by construction (DataAccess only returns statements reported on or before asOf). Free data covers
 * about 4 annual periods, so tests whose inputs are absent are SKIPPED, never failed and never scored as a neutral 50;
 * the score is the weighted mean of the sub-scores that exist. Only a failed test can FAIL the gate: F-score, the
 * solvency test of the instrument's model, a pending corporate action, or earnings inside the option window.
 */
import { diffDays } from '../core/dates';
import type { FundamentalStatement, Reason } from '../core/types';
import { lerpScore, median, round } from '../core/util';
import { type AnalysisSkill, fail, info, pass, type SkillResult, warnData, warnRule } from './contract';
import { fmt, pctStr } from './helpers';

const TOTAL_TESTS = 13;

export interface FundamentalPayload {
  fScore: number | null;
  fComponents: (boolean | null)[];
  zScore: number | null;
  gearing: number | null;
  interestCover: number | null;
  solvencyModel: string;
  roic5y: number | null;
  fcfYield: number | null;
  netDebtEbitda: number | null;
  gmStdev: number | null;
  revCagr3y: number | null;
  epsPosYears: number | null;
  divCut: boolean | null;
  evEbitZ: number | null;
  peZ: number | null;
  nextEarnings: string | null;
  earningsInWindow: boolean;
  dataAgeDays: number | null;
  subScores: { quality: number | null; strength: number | null; valuation: number | null };
  skipped: string[];
  statementCurrency: string | null;
  latestPeriodEnd: string | null;
}

const num = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function sampleStdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Piotroski components from two consecutive annual statements; null = not computable. */
export function piotroski(a0: FundamentalStatement, a1: FundamentalStatement): (boolean | null)[] {
  const ratio = (n: number | null, d: number | null): number | null => (num(n) && num(d) && d !== 0 ? n / d : null);
  const roa0 = ratio(a0.netIncome, a0.totalAssets);
  const roa1 = ratio(a1.netIncome, a1.totalAssets);
  const lev0 = ratio(a0.longTermDebt, a0.totalAssets);
  const lev1 = ratio(a1.longTermDebt, a1.totalAssets);
  const cr0 = ratio(a0.currentAssets, a0.currentLiabilities);
  const cr1 = ratio(a1.currentAssets, a1.currentLiabilities);
  const gm0 = ratio(a0.grossProfit, a0.revenue);
  const gm1 = ratio(a1.grossProfit, a1.revenue);
  const at0 = ratio(a0.revenue, a0.totalAssets);
  const at1 = ratio(a1.revenue, a1.totalAssets);
  const cmp = (x: number | null, y: number | null, f: (x: number, y: number) => boolean): boolean | null =>
    x !== null && y !== null ? f(x, y) : null;
  return [
    roa0 === null ? null : roa0 > 0,
    num(a0.cfo) ? a0.cfo > 0 : null,
    cmp(roa0, roa1, (x, y) => x > y),
    num(a0.cfo) && num(a0.netIncome) ? a0.cfo > a0.netIncome : null,
    cmp(lev0, lev1, (x, y) => x < y),
    cmp(cr0, cr1, (x, y) => x > y),
    num(a0.sharesDiluted) && num(a1.sharesDiluted) ? a0.sharesDiluted <= a1.sharesDiluted * 1.005 : null,
    cmp(gm0, gm1, (x, y) => x > y),
    cmp(at0, at1, (x, y) => x > y),
  ];
}

export const fundamentalGate: AnalysisSkill<FundamentalPayload> = {
  id: 'fundamental.gate',
  version: '1.1.0',
  dependsOn: [],
  paramKey: 'fundamental.gate',
  cacheable: true,

  async run(ctx): Promise<SkillResult<FundamentalPayload>> {
    const p = ctx.params['fundamental.gate'];
    const inst = ctx.instrument;
    const windowDays = ctx.params['option.select'].dteMax[inst.market];
    const reasons: Reason[] = [];
    const skipped: string[] = [];
    const skip = (name: string, why: string) => {
      skipped.push(name);
      return why;
    };

    const { statements } = await ctx.data.fundamentals();
    const annuals = statements.filter((s) => s.periodType === 'annual');
    const subType = inst.reportingFrequency === 'semiannual' ? 'semiannual' : 'quarterly';
    const subs = statements.filter(
      (s) => s.periodType === subType || (subType === 'semiannual' && s.periodType === 'quarterly'),
    );
    const a0 = annuals[annuals.length - 1] ?? null;
    const a1 = annuals[annuals.length - 2] ?? null;
    const bars = await ctx.data.bars(1700);
    const price = bars[bars.length - 1]?.close ?? null;
    const latestStmt = statements.reduce<FundamentalStatement | null>(
      (best, s) => (best === null || s.reportedAt > best.reportedAt ? s : best),
      null,
    );
    const dataAgeDays = latestStmt ? diffDays(ctx.asOf, latestStmt.reportedAt.slice(0, 10)) : null;
    const stmtCcy = a0?.currency ?? latestStmt?.currency ?? null;
    const fxRate = stmtCcy ? await ctx.data.fx(stmtCcy, inst.currency) : null; // statement ccy -> trading ccy
    const shares = [...annuals].reverse().find((s) => num(s.sharesDiluted))?.sharesDiluted ?? null;
    const mktCapTrading = num(price) && num(shares) ? price * shares : null;
    const mktCap = mktCapTrading !== null && fxRate ? mktCapTrading / fxRate : null; // in statement currency
    const fxMissingNote = stmtCcy && stmtCcy !== inst.currency && fxRate === null;

    const payload: FundamentalPayload = {
      fScore: null,
      fComponents: [],
      zScore: null,
      gearing: null,
      interestCover: null,
      solvencyModel: inst.solvencyModel,
      roic5y: null,
      fcfYield: null,
      netDebtEbitda: null,
      gmStdev: null,
      revCagr3y: null,
      epsPosYears: null,
      divCut: null,
      evEbitZ: null,
      peZ: null,
      nextEarnings: null,
      earningsInWindow: false,
      dataAgeDays,
      subScores: { quality: null, strength: null, valuation: null },
      skipped,
      statementCurrency: stmtCcy,
      latestPeriodEnd: a0?.periodEnd ?? null,
    };
    const qualityScores: number[] = [];
    const strengthScores: number[] = [];
    const valuationScores: number[] = [];

    // ---------------------------------------------------------- 1. Piotroski F-score
    if (a0 && a1) {
      const comps = piotroski(a0, a1);
      payload.fComponents = comps;
      const known = comps.filter((c): c is boolean => c !== null);
      if (known.length >= 6) {
        const passed = known.filter(Boolean).length;
        const f = Math.round((passed / known.length) * 9);
        payload.fScore = f;
        const note = `${passed}/${known.length} computable components${known.length < 9 ? ` (scaled to 9; ${9 - known.length} missing inputs)` : ''}`;
        if (f <= p.fScoreWarn - 1) {
          reasons.push(
            fail('fundamentals.fScore', f, {
              threshold: `>= ${p.fScoreMin} pass, ${p.fScoreWarn}-${p.fScoreMin - 1} warn`,
              note,
            }),
          );
        } else if (f < p.fScoreMin) {
          reasons.push(warnRule('fundamentals.fScore', f, { threshold: `>= ${p.fScoreMin}`, note }));
        } else {
          reasons.push(pass('fundamentals.fScore', f, { threshold: `>= ${p.fScoreMin}`, note }));
        }
        strengthScores.push(lerpScore(f, p.fScoreWarn - 1, p.fScoreExcellent));
      } else {
        reasons.push(
          info('fundamentals.fScore', 'skipped', {
            note: skip('fScore', `only ${known.length} of 9 components computable`),
          }),
        );
      }
    } else {
      reasons.push(
        info('fundamentals.fScore', 'skipped', {
          note: skip('fScore', `needs 2 annual statements, have ${annuals.length}`),
        }),
      );
    }

    // -------------------------------------------------------------- 2. solvency
    if (inst.solvencyModel === 'financial') {
      skip('solvency', 'financial model');
      reasons.push(
        warnData('solvency.financialSkipped', true, {
          note: 'banks and insurers: Altman Z misfires; solvency not tested in v1 (CET1 / combined ratio later)',
        }),
      );
    } else if (inst.solvencyModel === 'altman') {
      const ok =
        a0 &&
        mktCap !== null &&
        num(a0.currentAssets) &&
        num(a0.currentLiabilities) &&
        num(a0.totalAssets) &&
        a0.totalAssets > 0 &&
        num(a0.retainedEarnings) &&
        num(a0.ebit) &&
        num(a0.totalLiabilities) &&
        a0.totalLiabilities > 0 &&
        num(a0.revenue);
      if (ok && a0) {
        const ta = a0.totalAssets as number;
        const z =
          1.2 * (((a0.currentAssets as number) - (a0.currentLiabilities as number)) / ta) +
          1.4 * ((a0.retainedEarnings as number) / ta) +
          3.3 * ((a0.ebit as number) / ta) +
          0.6 * ((mktCap as number) / (a0.totalLiabilities as number)) +
          1.0 * ((a0.revenue as number) / ta);
        payload.zScore = z;
        const th = `> ${p.zPass} pass, ${p.zWarn}-${p.zPass} warn`;
        if (z < p.zWarn) reasons.push(fail('solvency.altmanZ', round(z, 2), { threshold: th, note: 'distress zone' }));
        else if (z <= p.zPass) reasons.push(warnRule('solvency.altmanZ', round(z, 2), { threshold: th }));
        else reasons.push(pass('solvency.altmanZ', round(z, 2), { threshold: th }));
        strengthScores.push(lerpScore(z, p.zWarn, p.zExcellent));
      } else {
        reasons.push(
          info('solvency.altmanZ', 'skipped', {
            note: skip(
              'solvency',
              fxMissingNote
                ? `no ${stmtCcy}->${inst.currency} FX rate`
                : 'missing balance-sheet, price or share-count inputs',
            ),
          }),
        );
      }
    } else {
      // property and reit: net gearing and interest cover
      const gPass = inst.solvencyModel === 'reit' ? p.reitGearingPass : p.gearingPass;
      const gWarn = inst.solvencyModel === 'reit' ? p.reitGearingWarn : p.gearingWarn;
      let ran = false;
      if (a0 && num(a0.totalDebt) && num(a0.cash) && num(a0.totalEquity) && a0.totalEquity > 0) {
        ran = true;
        const g = (a0.totalDebt - a0.cash) / a0.totalEquity;
        payload.gearing = g;
        const th = `<= ${pctStr(gPass, 0)} pass, <= ${pctStr(gWarn, 0)} warn`;
        if (g > gWarn) reasons.push(fail('solvency.gearing', pctStr(g), { threshold: th }));
        else if (g > gPass) reasons.push(warnRule('solvency.gearing', pctStr(g), { threshold: th }));
        else reasons.push(pass('solvency.gearing', pctStr(g), { threshold: th }));
        strengthScores.push(lerpScore(g, p.gearingWarn, p.gearingExcellent));
      }
      if (a0 && num(a0.ebit) && num(a0.interestExpense) && a0.interestExpense > 0) {
        ran = true;
        const c = a0.ebit / a0.interestExpense;
        payload.interestCover = c;
        const th = `>= ${p.interestCoverPass}x pass, >= ${p.interestCoverWarn}x warn`;
        if (c < p.interestCoverWarn) reasons.push(fail('solvency.interestCover', `${fmt(c, 1)}x`, { threshold: th }));
        else if (c < p.interestCoverPass)
          reasons.push(warnRule('solvency.interestCover', `${fmt(c, 1)}x`, { threshold: th }));
        else reasons.push(pass('solvency.interestCover', `${fmt(c, 1)}x`, { threshold: th }));
        strengthScores.push(lerpScore(c, p.interestCoverWarn, p.interestCoverExcellent));
      }
      if (!ran)
        reasons.push(
          info('solvency.gearing', 'skipped', {
            note: skip('solvency', 'missing debt, cash, equity or interest inputs'),
          }),
        );
    }

    // ----------------------------------------------------------------- 3. ROIC (5y median)
    const need = p.historyYears;
    {
      const last = annuals.slice(-need);
      const rois = last
        .map((s) => {
          if (!num(s.ebit) || !num(s.totalEquity) || !num(s.totalDebt) || !num(s.cash)) return null;
          const ic = s.totalEquity + s.totalDebt - s.cash;
          return ic > 0 ? (s.ebit * (1 - p.roicTaxRate)) / ic : null;
        })
        .filter((x): x is number => x !== null);
      if (last.length >= need && rois.length >= need) {
        const m = median(rois) as number;
        payload.roic5y = m;
        const th = `>= ${pctStr(p.roicMin, 0)}`;
        reasons.push(
          m >= p.roicMin
            ? pass('quality.roic5y', pctStr(m), { threshold: th })
            : warnRule('quality.roic5y', pctStr(m), { threshold: th }),
        );
        qualityScores.push(lerpScore(m, p.roicMin, p.roicExcellent));
      } else {
        reasons.push(
          info('quality.roic5y', 'skipped', {
            note: skip('roic5y', `needs ${need} annual statements, have ${annuals.length}`),
          }),
        );
      }
    }
    if (a0 && num(a0.fcf) && mktCap !== null && num(a0.totalDebt) && num(a0.cash)) {
      const ev = mktCap + a0.totalDebt - a0.cash;
      if (ev > 0) {
        const y = a0.fcf / ev;
        payload.fcfYield = y;
        const th = `>= ${pctStr(p.fcfYieldMin, 0)}`;
        reasons.push(
          y >= p.fcfYieldMin
            ? pass('quality.fcfYield', pctStr(y), { threshold: th })
            : warnRule('quality.fcfYield', pctStr(y), { threshold: th }),
        );
        qualityScores.push(lerpScore(y, p.fcfYieldMin, p.fcfYieldExcellent));
      } else
        reasons.push(info('quality.fcfYield', 'skipped', { note: skip('fcfYield', 'enterprise value not positive') }));
    } else {
      reasons.push(
        info('quality.fcfYield', 'skipped', {
          note: skip(
            'fcfYield',
            fxMissingNote ? `no ${stmtCcy}->${inst.currency} FX rate` : 'missing FCF, debt, cash or market cap',
          ),
        }),
      );
    }
    if (a0 && num(a0.totalDebt) && num(a0.cash) && num(a0.ebitda)) {
      const nd = a0.totalDebt - a0.cash;
      const x = a0.ebitda > 0 ? nd / a0.ebitda : nd > 0 ? Number.POSITIVE_INFINITY : -1;
      payload.netDebtEbitda = Number.isFinite(x) ? x : null;
      const th = `<= ${p.netDebtEbitdaMax}`;
      reasons.push(
        x <= p.netDebtEbitdaMax
          ? pass('quality.netDebtEbitda', nd < 0 ? 'net cash' : fmt(x, 2), { threshold: th })
          : warnRule('quality.netDebtEbitda', Number.isFinite(x) ? fmt(x, 2) : 'EBITDA <= 0', { threshold: th }),
      );
      qualityScores.push(lerpScore(Number.isFinite(x) ? x : 99, p.netDebtEbitdaMax, p.netDebtEbitdaExcellent));
    } else {
      reasons.push(
        info('quality.netDebtEbitda', 'skipped', { note: skip('netDebtEbitda', 'missing debt, cash or EBITDA') }),
      );
    }

    // ------------------------------------------- 6. gross-margin stability (8 periods)
    {
      const gms = subs
        .slice(-8)
        .map((s) =>
          num(s.grossProfit) && num(s.revenue) && s.revenue !== 0 ? (s.grossProfit / s.revenue) * 100 : null,
        );
      if (subs.length >= 8 && gms.every((x) => x !== null)) {
        const sd = sampleStdev(gms as number[]) as number;
        payload.gmStdev = sd;
        const th = `<= ${p.gmStdevMaxPts} pts`;
        reasons.push(
          sd <= p.gmStdevMaxPts
            ? pass('quality.gmStability', `${fmt(sd, 2)} pts`, { threshold: th })
            : warnRule('quality.gmStability', `${fmt(sd, 2)} pts`, { threshold: th }),
        );
        qualityScores.push(lerpScore(sd, p.gmStdevMaxPts, p.gmStdevExcellent));
      } else {
        reasons.push(
          info('quality.gmStability', 'skipped', {
            note: skip('gmStdev', `needs 8 ${subType} periods, have ${subs.length}`),
          }),
        );
      }
    }

    // ------------------------------------------------------ 7. revenue CAGR 3y
    {
      const r0 = annuals[annuals.length - 1]?.revenue;
      const r3 = annuals[annuals.length - 4]?.revenue;
      if (annuals.length >= 4 && num(r0) && num(r3) && r3 > 0 && r0 > 0) {
        const c = (r0 / r3) ** (1 / 3) - 1;
        payload.revCagr3y = c;
        const th = `>= ${pctStr(p.revCagr3yMin, 0)}`;
        reasons.push(
          c >= p.revCagr3yMin
            ? pass('quality.revenueCagr3y', pctStr(c), { threshold: th })
            : warnRule('quality.revenueCagr3y', pctStr(c), { threshold: th }),
        );
        qualityScores.push(lerpScore(c, p.revCagr3yMin, p.revCagrExcellent));
      } else {
        reasons.push(
          info('quality.revenueCagr3y', 'skipped', {
            note: skip('revCagr3y', `needs 4 annual statements with revenue, have ${annuals.length}`),
          }),
        );
      }
    }

    // --------------------------------------------------- 8. EPS positive years
    {
      const last = annuals.slice(-4);
      const eps = last.map((s) => (num(s.epsDiluted) ? s.epsDiluted : num(s.netIncome) ? s.netIncome : null));
      if (last.length >= 3 && eps.every((x) => x !== null)) {
        const n = eps.filter((x) => (x as number) > 0).length;
        payload.epsPosYears = n;
        const th = `>= ${p.epsPositiveYearsMin} of last ${last.length}`;
        reasons.push(
          n >= p.epsPositiveYearsMin
            ? pass('quality.epsPositiveYears', n, { threshold: th })
            : warnRule('quality.epsPositiveYears', n, { threshold: th }),
        );
        qualityScores.push(lerpScore(n, p.epsPositiveYearsMin, last.length));
      } else {
        reasons.push(
          info('quality.epsPositiveYears', 'skipped', {
            note: skip('epsPosYears', `needs 3-4 annual EPS values, have ${annuals.length}`),
          }),
        );
      }
    }

    // ------------------------------------------------------- 9. dividend cut
    {
      const paid = annuals.slice(-4).map((s) => (num(s.dividendsPaid) ? Math.abs(s.dividendsPaid) : null));
      if (annuals.length >= 2 && paid.every((x) => x !== null)) {
        const ps = paid as number[];
        let cut = false;
        for (let i = 1; i < ps.length; i++)
          if ((ps[i - 1] as number) > 0 && (ps[i] as number) < (ps[i - 1] as number) * p.dividendCutFactor) cut = true;
        payload.divCut = cut;
        reasons.push(
          cut
            ? warnRule('quality.dividendCut', true, { threshold: 'no cut in the last 3 years' })
            : pass('quality.dividendCut', false, {
                threshold: 'no cut in the last 3 years',
                note: ps.every((x) => x === 0) ? 'no dividends paid' : undefined,
              }),
        );
        qualityScores.push(cut ? 0 : 100);
      } else {
        reasons.push(
          info('quality.dividendCut', 'skipped', { note: skip('divCut', 'needs 2+ annual dividend figures') }),
        );
      }
    }

    // ------------------------------------------------ 10-11. valuation vs own history
    const priceAt = (day: string): number | null => {
      let lo = 0;
      let hi = bars.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((bars[mid]?.day as string) <= day) lo = mid + 1;
        else hi = mid;
      }
      return lo === 0 ? null : (bars[lo - 1]?.close as number);
    };
    const zOf = (cur: number, hist: number[]): number | null => {
      if (hist.length < need - 1) return null;
      const m = mean(hist) as number;
      const sd = sampleStdev(hist);
      return sd && sd > 0 ? (cur - m) / sd : null;
    };
    const valuationTest = (
      name: string,
      key: 'evEbitZ' | 'peZ',
      multiple: (s: FundamentalStatement, px: number) => number | null,
      label: string,
    ) => {
      const last = annuals.slice(-need);
      if (last.length < need || price === null || fxRate === null) {
        reasons.push(
          info(label, 'skipped', {
            note: skip(
              name,
              last.length < need ? `needs ${need} annual statements, have ${annuals.length}` : 'no price or FX rate',
            ),
          }),
        );
        return;
      }
      const cur = multiple(last[last.length - 1] as FundamentalStatement, price);
      const hist = last
        .slice(0, -1)
        .map((s) => {
          const px = priceAt(s.reportedAt.slice(0, 10));
          return px === null ? null : multiple(s, px);
        })
        .filter((x): x is number => x !== null);
      const z = cur === null ? null : zOf(cur, hist);
      if (z === null) {
        reasons.push(
          info(label, 'skipped', {
            note: skip(name, 'multiple not computable over 5 years (negative earnings or missing prices)'),
          }),
        );
        return;
      }
      payload[key] = z;
      const th = `<= ${p.valuationZMax} sigma vs own ${need}y history`;
      reasons.push(
        z <= p.valuationZMax
          ? pass(label, `${fmt(z, 2)} sigma`, { threshold: th })
          : warnRule(label, `${fmt(z, 2)} sigma`, {
              threshold: th,
              note: 'expensive versus its own history: a penalty, not a fail',
            }),
      );
      valuationScores.push(lerpScore(z, p.valuationZMax, p.valuationZExcellent));
    };
    const toStmtCcy = (px: number) => px / (fxRate ?? 1);
    valuationTest(
      'evEbitZ',
      'evEbitZ',
      (s, px) => {
        if (!num(s.ebit) || s.ebit <= 0 || !num(s.sharesDiluted) || !num(s.totalDebt) || !num(s.cash)) return null;
        return (toStmtCcy(px) * s.sharesDiluted + s.totalDebt - s.cash) / s.ebit;
      },
      'valuation.evEbitZ',
    );
    valuationTest(
      'peZ',
      'peZ',
      (s, px) => (num(s.epsDiluted) && s.epsDiluted > 0 ? toStmtCcy(px) / s.epsDiluted : null),
      'valuation.peZ',
    );

    // ------------------------------------------------ 12. pending corporate action
    const { events } = await ctx.data.calendar();
    const pending = events.filter(
      (e) =>
        e.date >= ctx.asOf &&
        (e.type === 'rights_issue' ||
          e.type === 'spin_off' ||
          (e.type === 'other' && e.details?.kind === 'privatisation')),
    );
    if (pending.length) {
      const e = pending[0] as (typeof pending)[number];
      reasons.push(
        fail('events.pendingCorporateAction', `${e.type} ${e.date}`, {
          note: 'rights issue, spin-off or privatisation pending',
        }),
      );
    } else {
      reasons.push(pass('events.pendingCorporateAction', false));
    }

    // ------------------------------------------------ 13. earnings inside the option window
    const upcoming = events
      .filter((e) => e.type === 'earnings' && e.date >= ctx.asOf)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!upcoming) {
      reasons.push(
        warnData('events.earningsUnknown', true, {
          note: `no earnings date known for ${inst.market}:${inst.symbol} (common for HK on free data): add one with \`events add\``,
        }),
      );
      skip('earningsWindow', 'unknown earnings date');
    } else {
      payload.nextEarnings = upcoming.date;
      const inside = diffDays(upcoming.date, ctx.asOf) <= windowDays;
      payload.earningsInWindow = inside;
      const note = `${upcoming.confirmed ? 'confirmed' : 'estimated'} (${upcoming.source})`;
      // docs/01 A5: event risk is evaluated PER CANDIDATE EXPIRY. Earnings before the earliest allowed expiry (dteMin)
      // sit inside every candidate's life: FAIL. Between dteMin and dteMax only the expiries before the date qualify,
      // and S4 enforces that (events.earningsBeforeExpiry when none is left).
      const earliestExpiryDays = ctx.params['option.select'].dteMin[inst.market];
      const spansEveryExpiry = diffDays(upcoming.date, ctx.asOf) <= earliestExpiryDays;
      if (!inside)
        reasons.push(
          pass('events.earningsWindow', upcoming.date, { threshold: `outside the next ${windowDays} days`, note }),
        );
      else if (p.allowEarningsInWindow) {
        reasons.push(
          warnRule('events.earningsWindow', upcoming.date, {
            threshold: `outside the next ${windowDays} days`,
            note: `${note}; allowed only with IV rank >= ${p.earningsIvrOverride}, size halved`,
          }),
        );
      } else if (spansEveryExpiry) {
        reasons.push(
          fail('events.earningsWindow', upcoming.date, {
            threshold: `after the earliest allowed expiry (${earliestExpiryDays} days out)`,
            note: `${note}; every candidate expiry spans the results`,
          }),
        );
      } else {
        reasons.push(
          pass('events.earningsWindow', upcoming.date, {
            threshold: `no expiry may reach ${upcoming.date}`,
            note: `${note}; only expiries before this date qualify (enforced in option.select)`,
          }),
        );
      }
    }

    // ------------------------------------------------------------ score and verdict
    const subScores = {
      quality: mean(qualityScores),
      strength: mean(strengthScores),
      valuation: mean(valuationScores),
    };
    payload.subScores = {
      quality: subScores.quality === null ? null : round(subScores.quality, 1),
      strength: subScores.strength === null ? null : round(subScores.strength, 1),
      valuation: subScores.valuation === null ? null : round(subScores.valuation, 1),
    };
    let wsum = 0;
    let acc = 0;
    for (const k of ['quality', 'strength', 'valuation'] as const) {
      const s = subScores[k];
      if (s === null) continue;
      wsum += p.weights[k];
      acc += p.weights[k] * s;
    }
    const score = wsum > 0 ? round(acc / wsum, 1) : null;

    if (skipped.length > 0) {
      reasons.push(
        info('fundamentals.partialCoverage', skipped.length, {
          note: `skipped: ${skipped.join(', ')}; score is the weighted mean of the sub-scores that exist`,
        }),
      );
    }
    if (a0?.reportedAtEstimated) {
      reasons.push(
        info('fundamentals.estimatedFilingDate', true, {
          kind: 'data',
          note: `reported_at estimated for ${a0.periodEnd} (market lag clamped by first_seen_at)`,
        }),
      );
    }
    if (skipped.length / TOTAL_TESTS > p.maxSkippedFraction) {
      reasons.unshift(
        warnData('fundamentals.insufficientData', `${skipped.length}/${TOTAL_TESTS} tests skipped`, {
          threshold: `<= ${Math.floor(TOTAL_TESTS * p.maxSkippedFraction)} skipped`,
        }),
      );
    }

    const verdict = reasons.some((r) => r.level === 'FAIL')
      ? 'FAIL'
      : reasons.some((r) => r.level === 'WARN')
        ? 'WARN'
        : 'PASS';
    return {
      skillId: this.id,
      version: this.version,
      score,
      verdict,
      reasons,
      payload,
      dataQuality: { tier: a0?.reportedAtEstimated || !a0 ? 'proxy' : 'real', missing: skipped },
    };
  },
};
