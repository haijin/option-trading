import { riskFreeFor } from '../core/contracts';
import { addDays, diffDays, type ISODate } from '../core/dates';
import type { DailyBar, Reason } from '../core/types';
import { clamp, median, round } from '../core/util';
import {
  iv30 as chainIv30,
  skew25d as chainSkew,
  percentileRank,
  rankInRange,
  realizedVol,
  yangZhangVol,
} from '../indicators';
import type { Series } from '../indicators/types';
import { type AnalysisSkill, fail, info, pass, type SkillResult, warnData, warnRule } from './contract';
import { fmt, lastOf, pctStr } from './helpers';

export type VolTier = 'real' | 'proxy' | 'rvOnly';

/** One forward-aligned observation: IV30 stored on `day` against the realised vol of the window that ends on `end`. */
export interface VrpObservation {
  day: ISODate;
  end: ISODate;
  iv30: number;
  /** Annualised close-to-close realised vol of the log returns over (day, end]. */
  rv: number;
  /** iv30 - rv in vol points (x100). */
  gapPts: number;
}

export interface ForwardVrp {
  /** Trading days per window. */
  window: number;
  /** Windows measured (oldest first in `series`). */
  observations: number;
  /** Windows where implied was above the realised vol that followed. */
  above: number;
  /** Mean of iv30 - subsequent realised, in vol points. */
  meanGapPts: number;
  series: VrpObservation[];
}

export interface VolatilityPayload {
  iv30: number | null;
  iv60: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  rv20: number | null;
  rv60: number | null;
  /** Trailing IV30 / RV20 (not forward-aligned; kept for display and the score tilt). */
  vrpRatio: number | null;
  /** Forward-aligned variance risk premium over the last `vrpObservations` windows; null when unmeasured. */
  vrpForward: ForwardVrp | null;
  /** Annualised realised vol over the most recent completed `vrpWindowDays` window (bars only; null without bars). */
  rvRecent: number | null;
  termRatio: number | null;
  skew25d: number | null;
  tier: VolTier | null;
  ivSource: 'chain' | 'volIndexProxy' | 'rvOnly' | null;
  /** What the rank/percentile were computed against: 'real' stored IV history, a vol-index 'proxy' series, or 'rv'. */
  rankBasis: 'real' | 'proxy' | 'rv' | null;
  /** IV/RV ratio used for the rvOnly tier and whether it was calibrated. */
  ivRvRatio: { value: number; calibrated: boolean } | null;
  /** Where today's IV comes from (trade-skills T3): event IV crushes on the date, demand IV may persist. */
  ivOrigin: IvOrigin | null;
  /** Calendar days to the next known results date, or null when none is known. */
  daysToResults: number | null;
}

export type IvOrigin = 'event' | 'demand' | 'unknown';

/**
 * IV-source reason (pitfalls 21 and 7 of himself65/trade-skills). Results within `eventDays` with a front-heavy term
 * structure (front / next IV >= `frontHeavyMin`) is event IV: it crushes on the date, so the premium is the event's,
 * not a lasting edge. No result within `demandDays` (none known, or further out) with an IV rank above `ivrMin` is
 * demand IV: someone wants protection and the level may persist, which is a WARN on a short put. Otherwise unknown.
 */
export function classifyIvOrigin(i: {
  daysToResults: number | null;
  termRatio: number | null;
  ivRank: number | null;
  eventDays: number;
  frontHeavyMin: number;
  demandDays: number;
  ivrMin: number;
}): IvOrigin {
  if (
    i.daysToResults !== null &&
    i.daysToResults >= 0 &&
    i.daysToResults <= i.eventDays &&
    i.termRatio !== null &&
    i.termRatio >= i.frontHeavyMin
  )
    return 'event';
  const noDatedEvent = i.daysToResults === null || i.daysToResults > i.demandDays;
  if (noDatedEvent && i.ivRank !== null && i.ivRank > i.ivrMin) return 'demand';
  return 'unknown';
}

const RANK_WINDOW = 252;
const VOL_INDEX_MAX_LAG_DAYS = 5;
/** Calendar days of stored IV fetched once: covers the rank window (365) and the forward windows (about 14 months). */
const IV_HISTORY_DAYS = 730;

interface YzSeries {
  yz20: Series;
  yz60: Series;
}

function dayMap(bars: DailyBar[], s: Series): Map<string, number> {
  const m = new Map<string, number>();
  bars.forEach((b, i) => {
    const v = s[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) m.set(b.day, v);
  });
  return m;
}

/** Piecewise IV-rank score: 30 -> 50, 50 -> 75, 70+ -> 100, linear in between and 0 -> 0 below 30. */
export function ivRankScore(rank: number): number {
  if (rank >= 70) return 100;
  if (rank >= 50) return 75 + ((rank - 50) / 20) * 25;
  if (rank >= 30) return 50 + ((rank - 30) / 20) * 25;
  return (rank / 30) * 50;
}

/**
 * Forward-aligned VRP series (pitfall 36 of himself65/trade-skills): for a window starting at bar s and ending at bar
 * e = s + window, pair the IV30 stored on bars[s].day with the realised vol of the `window` log returns over (s, e].
 * Walks back from the last bar, keeps windows that do not overlap (each end <= the next window's start) and whose start
 * day has a stored IV, and stops after `count`. Returned oldest first; the last entry ends on the last bar.
 * A start day without a stored IV shifts the window one bar earlier, which keeps the series honest on gappy history.
 */
export function forwardVrpSeries(
  bars: readonly DailyBar[],
  ivByDay: ReadonlyMap<string, number>,
  window: number,
  count: number,
): VrpObservation[] {
  if (window < 2 || count < 1 || bars.length <= window) return [];
  const rv = realizedVol(
    bars.map((b) => b.close),
    window,
  );
  const out: VrpObservation[] = [];
  let end = bars.length - 1; // the latest bar the next window may end on
  while (end - window >= 0 && out.length < count) {
    const start = end - window;
    const startBar = bars[start] as DailyBar;
    const iv = ivByDay.get(startBar.day);
    const vol = rv[end];
    if (iv === undefined || vol === null || vol === undefined || !Number.isFinite(vol)) {
      end -= 1;
      continue;
    }
    out.push({
      day: startBar.day,
      end: (bars[end] as DailyBar).day,
      iv30: iv,
      rv: vol,
      gapPts: (iv - vol) * 100,
    });
    end = start; // the next window's returns end where this one's begin: no overlap
  }
  return out.reverse();
}

export function summariseForwardVrp(series: VrpObservation[], window: number): ForwardVrp {
  const above = series.filter((o) => o.iv30 > o.rv).length;
  const meanGapPts = series.length ? series.reduce((a, o) => a + o.gapPts, 0) / series.length : 0;
  return { window, observations: series.length, above, meanGapPts, series };
}

export const volatilityEdge: AnalysisSkill<VolatilityPayload> = {
  id: 'volatility.edge',
  version: '1.2.0',
  dependsOn: [],
  paramKey: 'volatility.edge',
  cacheable: true,

  async run(ctx): Promise<SkillResult<VolatilityPayload>> {
    const p = ctx.params['volatility.edge'];
    const optParams = ctx.params['option.select'];
    const market = ctx.instrument.market;
    const rf = riskFreeFor(market, optParams.riskFreeUS, optParams.riskFreeHK);
    const reasons: Reason[] = [];
    const missing: string[] = [];

    const bars = await ctx.data.bars(420);
    const yz = ctx.data.memo<YzSeries>('vol.yz', () => ({
      yz20: yangZhangVol(bars, 20),
      yz60: yangZhangVol(bars, 60),
    }));
    const rv20 = lastOf(yz.yz20);
    const rv60 = lastOf(yz.yz60);
    if (rv60 === null) missing.push('bars');
    const vrpWindow = Math.max(2, Math.round(p.vrpWindowDays));
    const rvRecent =
      bars.length > vrpWindow
        ? lastOf(
            realizedVol(
              bars.slice(-(vrpWindow + 1)).map((b) => b.close),
              vrpWindow,
            ),
          )
        : null;

    const m = await ctx.data.market();
    const lastBarDay = bars[bars.length - 1]?.day ?? null;
    const volLast = m.volIndexBars[m.volIndexBars.length - 1] ?? null;
    const volOk =
      volLast !== null && lastBarDay !== null && diffDays(lastBarDay, volLast.day) <= VOL_INDEX_MAX_LAG_DAYS;
    const indexYz = yangZhangVol(m.indexBars, 60);
    const indexRv60 = lastOf(indexYz);

    const chain = await ctx.data.chain();
    const chainIv = chain ? chainIv30(chain, rf) : null;

    // next known results date (the calendar is knownAt-bounded, so a replay sees only what was known then)
    const { events } = await ctx.data.calendar();
    const nextResults = events
      .filter((e) => e.type === 'earnings' && e.date >= ctx.asOf)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    const daysToResults = nextResults ? diffDays(nextResults.date, ctx.asOf) : null;

    // rolling rv60 x ratio, and the vol-index proxy series, over the rank window
    const calib = await ctx.data.calibration(p.calibrationMinSamples);
    const ratioDefault = p.ivRvRatioDefault[market];
    const ratio = calib.ivRvRatio?.median ?? ratioDefault;
    const proxySeries = (): number[] => {
      if (!volOk || indexRv60 === null) return [];
      const stockRv = dayMap(bars, yz.yz60);
      const idxRv = dayMap(m.indexBars, indexYz);
      const vol = new Map(m.volIndexBars.map((b) => [b.day, b.close]));
      const out: number[] = [];
      for (const b of bars.slice(-RANK_WINDOW)) {
        const s = stockRv.get(b.day);
        const i = idxRv.get(b.day);
        const v = vol.get(b.day);
        if (s === undefined || v === undefined) continue;
        const beta = p.proxyBeta && i !== undefined && i > 0 ? clamp(s / i, 0.2, 5) : 1;
        out.push((v / 100) * beta);
      }
      return out;
    };
    const rvSeries = (): number[] =>
      yz.yz60
        .slice(-RANK_WINDOW)
        .filter((x): x is number => x !== null)
        .map((x) => x * ratio);

    let tier: VolTier | null = null;
    let ivSource: VolatilityPayload['ivSource'] = null;
    let iv30: number | null = null;
    let iv60: number | null = null;
    let termRatio: number | null = null;
    let skew: number | null = null;

    if (chainIv) {
      tier = 'real';
      ivSource = 'chain';
      iv30 = chainIv.iv30;
      iv60 = chainIv.iv60;
      termRatio = chainIv.termRatio;
      skew = chain ? chainSkew(chain, rf) : null;
      reasons.push(
        info('iv.chain', round(iv30, 4), {
          note: `${chain?.source} chain ${chain?.snapshotDate}${chainIv.usedImpliedFromMid ? ', some IVs implied from mid' : ''}`,
        }),
      );
      if (chainIv.extrapolated)
        reasons.push(
          warnData('iv.extrapolatedTenor', chainIv.frontDte, {
            note: '30 days lies outside the listed expiries; nearest expiry used',
          }),
        );
    } else if (volOk && volLast && rv60 !== null && indexRv60 !== null) {
      tier = 'proxy';
      ivSource = 'volIndexProxy';
      const beta = p.proxyBeta && indexRv60 > 0 ? clamp(rv60 / indexRv60, 0.2, 5) : 1;
      iv30 = (volLast.close / 100) * beta;
      reasons.push(
        warnData('iv.proxy', round(iv30, 4), {
          note: `${m.volIndexSymbol} ${fmt(volLast.close, 1)} x stock/index RV60 beta ${fmt(beta, 2)}`,
        }),
      );
    } else if (rv60 !== null) {
      tier = 'rvOnly';
      ivSource = 'rvOnly';
      iv30 = rv60 * ratio;
      reasons.push(
        warnData('iv.rvOnly', round(iv30, 4), {
          note: `RV60 x ${fmt(ratio, 2)} (${calib.ivRvRatio ? 'calibrated' : 'default'} IV/RV ratio): no chain and no vol index`,
        }),
      );
    }

    if (tier === null || iv30 === null) {
      reasons.push(warnData('iv.noData', true, { note: 'not enough price history to estimate volatility' }));
      return {
        skillId: this.id,
        version: this.version,
        score: null,
        verdict: 'NA',
        reasons,
        payload: {
          iv30: null,
          iv60: null,
          ivRank: null,
          ivPercentile: null,
          rv20,
          rv60,
          vrpRatio: null,
          vrpForward: null,
          rvRecent,
          termRatio: null,
          skew25d: null,
          tier: null,
          ivSource: null,
          rankBasis: null,
          ivRvRatio: null,
          ivOrigin: null,
          daysToResults,
        },
        dataQuality: { tier: 'proxy', missing },
      };
    }

    // ------- IV rank / percentile
    const storedIv = (await ctx.data.ivHistory(IV_HISTORY_DAYS)).filter((x) => x.tier === 'real');
    // term ratio: the live chain's when there is one, else the latest stored iv_daily.term_ratio
    if (termRatio === null) {
      const withTerm = storedIv.filter((x) => x.termRatio !== null && x.termRatio !== undefined);
      const latest = withTerm[withTerm.length - 1];
      if (latest) termRatio = latest.termRatio as number;
    }
    let series: number[] = [];
    let rankBasis: VolatilityPayload['rankBasis'] = null;
    if (tier === 'real') {
      const rankFrom = addDays(ctx.asOf, -365);
      const hist = storedIv.filter((x) => x.day !== ctx.asOf && x.day >= rankFrom).map((x) => x.iv30);
      if (hist.length >= p.ivHistoryMinPoints) {
        series = [...hist, iv30];
        rankBasis = 'real';
      } else {
        const proxy = proxySeries();
        if (proxy.length >= 60) {
          series = proxy;
          rankBasis = 'proxy';
          reasons.push(
            warnData('iv.rankOnProxy', hist.length, {
              threshold: `>= ${p.ivHistoryMinPoints} stored IV points`,
              note: `only ${hist.length} real IV30 points stored; rank vs the ${m.volIndexSymbol} proxy series`,
            }),
          );
        } else {
          const rv = rvSeries();
          if (rv.length >= 60) {
            series = rv;
            rankBasis = 'rv';
            reasons.push(
              warnData('iv.rankOnRv', hist.length, {
                note: `only ${hist.length} real IV30 points stored and no vol index; rank vs RV60 x ${fmt(ratio, 2)} history`,
              }),
            );
          }
        }
      }
    } else if (tier === 'proxy') {
      series = proxySeries();
      rankBasis = 'proxy';
    } else {
      series = rvSeries();
      rankBasis = 'rv';
    }
    const ivRank = series.length >= 20 ? rankInRange(series, iv30) : null;
    const ivPercentile = series.length >= 20 ? percentileRank(series, iv30) : null;
    if (ivRank === null) missing.push('ivRank');

    const vrp = rv20 !== null && rv20 > 0 ? iv30 / rv20 : null;
    if (vrp === null) missing.push('rv20');

    // ------- unscored tier: a constant times RV is not an edge
    if (tier === 'rvOnly') {
      reasons.push(
        warnData('iv.unscored', true, {
          note: 'IV = RV60 x constant: the VRP ratio is that constant and the rank is a realised-vol rank; not scored',
        }),
      );
      return {
        skillId: this.id,
        version: this.version,
        score: null,
        verdict: 'NA',
        reasons,
        payload: {
          iv30,
          iv60: null,
          ivRank,
          ivPercentile,
          rv20,
          rv60,
          vrpRatio: vrp,
          vrpForward: null,
          rvRecent,
          termRatio: null,
          skew25d: null,
          tier,
          ivSource,
          rankBasis,
          ivRvRatio: { value: ratio, calibrated: calib.ivRvRatio !== null },
          ivOrigin: null,
          daysToResults,
        },
        dataQuality: { tier: 'proxy', missing },
      };
    }

    // ------- where today's IV comes from (T3, pitfalls 21 and 7) and the IV floor before a result (pitfall 37)
    const ivOrigin = classifyIvOrigin({
      daysToResults,
      termRatio,
      ivRank,
      eventDays: p.ivSourceEventDays,
      frontHeavyMin: p.ivSourceFrontHeavyMin,
      demandDays: p.ivSourceDemandDays,
      ivrMin: p.ivrMin,
    });
    const resultsText = nextResults ? `results ${nextResults.date} in ${daysToResults} days` : 'no results date known';
    reasons.push(
      ivOrigin === 'event'
        ? info('vol.ivSource', 'event', {
            threshold: `results within ${p.ivSourceEventDays} days and front / next IV >= ${fmt(p.ivSourceFrontHeavyMin, 2)}`,
            note: `event IV, will crush on the date: ${resultsText}, term ratio ${fmt(termRatio, 2)}; the premium is the event's, not a lasting edge`,
          })
        : ivOrigin === 'demand'
          ? warnRule('vol.ivSource', 'demand', {
              threshold: `no results within ${p.ivSourceDemandDays} days and IV rank > ${p.ivrMin}`,
              note: `demand IV, may persist: ${resultsText}, IV rank ${fmt(ivRank, 0)}; someone is paying for protection with no event to explain it, a short put may not see this IV decay`,
            })
          : info('vol.ivSource', 'unknown', {
              note: `neither event nor demand IV: ${resultsText}, term ratio ${termRatio === null ? 'n/a' : fmt(termRatio, 2)}, IV rank ${fmt(ivRank, 0)}`,
            }),
    );
    if (
      ivPercentile !== null &&
      ivPercentile <= p.ivFloorPercentileMax &&
      daysToResults !== null &&
      daysToResults >= p.ivFloorRampMinDays &&
      daysToResults <= p.ivFloorRampMaxDays
    ) {
      reasons.push(
        warnRule('vol.ivFloorRamp', round(ivPercentile, 1), {
          threshold: `IV percentile > ${p.ivFloorPercentileMax}, or results outside ${p.ivFloorRampMinDays} to ${p.ivFloorRampMaxDays} days`,
          note: `IV ramp ahead: IV percentile ${fmt(ivPercentile, 0)} is at its floor with results ${nextResults?.date} in ${daysToResults} days; premium sold now is the cheapest it will be before them, wait for the ramp`,
        }),
      );
    }

    // ------- forward-aligned VRP: IV30 at t against the realised vol of the window that followed
    // Measured only on real stored IV ranked against real history; a proxy or RV-based series would compare a
    // constant times realised vol with realised vol, which is the "measurement trap" the rule exists to avoid.
    const fwdObs = Math.max(1, Math.round(p.vrpObservations));
    let vrpForward: ForwardVrp | null = null;
    if (tier === 'real' && rankBasis === 'real') {
      const ivByDay = new Map(storedIv.map((x) => [x.day, x.iv30] as const));
      const fwdSeries = forwardVrpSeries(bars, ivByDay, vrpWindow, fwdObs);
      if (fwdSeries.length >= fwdObs) vrpForward = summariseForwardVrp(fwdSeries, vrpWindow);
      else
        reasons.push(
          info('vol.vrpUnmeasured', fwdSeries.length, {
            threshold: `${fwdObs} windows of ${vrpWindow} trading days with stored IV30 at the start`,
            note: `only ${fwdSeries.length} completed forward window(s) have a stored real IV30: the forward VRP is unmeasured and not counted against the name`,
          }),
        );
    } else {
      reasons.push(
        info('vol.vrpUnmeasured', 0, {
          threshold: 'real IV30 ranked against stored real history',
          note: `IV basis is ${rankBasis ?? tier}: a proxy or realised-vol series cannot be tested against the vol that followed; not counted against the name`,
        }),
      );
    }
    const fwdPositive = vrpForward !== null && vrpForward.above >= p.vrpPositiveMin;
    const fwdNegative = vrpForward !== null && vrpForward.observations - vrpForward.above >= p.vrpNegativeMin;

    if (vrpForward) {
      const n = vrpForward.observations;
      const first = vrpForward.series[0] as VrpObservation;
      const last = vrpForward.series[n - 1] as VrpObservation;
      const span = `${first.day} to ${last.end}`;
      reasons.push(
        fwdPositive
          ? pass('vol.vrpForward', vrpForward.above, {
              threshold: `implied above subsequent realised in >= ${p.vrpPositiveMin} of ${n} windows`,
              note: `${vrpForward.above} of ${n} non-overlapping ${vrpWindow}-day windows (${span}): selling this IV has paid`,
            })
          : fwdNegative
            ? warnRule('vol.vrpForward', vrpForward.above, {
                threshold: `implied above subsequent realised in >= ${p.vrpPositiveMin} of ${n} windows`,
                note: `implied below the vol that followed in ${n - vrpForward.above} of ${n} windows (${span}): structurally negative premium, IV rank cannot lift it`,
              })
            : info('vol.vrpForward', vrpForward.above, {
                threshold: `implied above subsequent realised in >= ${p.vrpPositiveMin} of ${n} windows`,
                note: `${vrpForward.above} of ${n} windows (${span}): mixed, no structural premium either way`,
              }),
      );
      reasons.push(
        info('vol.vrpGap', round(vrpForward.meanGapPts, 1), {
          note: `mean IV30 minus the realised vol that followed, in vol points, over the ${n} windows`,
        }),
      );
      reasons.push(
        info('vol.vrpLive', round((iv30 - last.rv) * 100, 1), {
          note: `live IV30 ${pctStr(iv30)} vs ${pctStr(last.rv)} realised over the last completed window (${last.day} to ${last.end}); the IV30 sold then was ${pctStr(last.iv30)}`,
        }),
      );
    }

    // ------- score
    const ivrOk = ivRank !== null;
    const vrpOk = vrp !== null;
    reasons.push(
      ivrOk
        ? (ivRank as number) >= p.ivrMin
          ? pass('vol.ivRank', round(ivRank as number, 1), {
              threshold: `>= ${p.ivrMin} (good ${p.ivrGood}, great ${p.ivrGreat})`,
              note: `percentile ${fmt(ivPercentile, 0)}, basis ${rankBasis}`,
            })
          : warnRule('vol.ivRank', round(ivRank as number, 1), {
              threshold: `>= ${p.ivrMin}`,
              note: `percentile ${fmt(ivPercentile, 0)}, basis ${rankBasis}`,
            })
        : warnData('vol.ivRank', 'n/a', { note: 'not enough history to rank' }),
    );
    reasons.push(
      vrpOk
        ? (vrp as number) >= p.vrpMinRatio
          ? pass('vol.vrp', round(vrp as number, 2), {
              threshold: `trailing IV30 / RV20 >= ${p.vrpMinRatio} (good ${p.vrpGoodRatio})`,
              note: `trailing: IV30 ${pctStr(iv30)} vs RV20 ${pctStr(rv20)} (the window already behind us, not the one being sold)`,
            })
          : warnRule('vol.vrp', round(vrp as number, 2), {
              threshold: `trailing IV30 / RV20 >= ${p.vrpMinRatio}`,
              note: `trailing: IV30 ${pctStr(iv30)} vs RV20 ${pctStr(rv20)} (the window already behind us, not the one being sold)`,
            })
        : warnData('vol.vrp', 'n/a', { note: 'no realised vol' }),
    );

    let score: number | null = null;
    if (ivrOk) {
      let s = ivRankScore(ivRank as number);
      if (vrpOk) s += clamp(((vrp as number) - 1) / (p.vrpGoodRatio - 1), -1, 1) * 10;
      if (termRatio !== null && termRatio > p.termBackwardationMax) {
        s -= p.backwardationPenalty;
        reasons.push(
          warnRule('vol.backwardation', round(termRatio, 3), {
            threshold: `front/next IV <= ${p.termBackwardationMax}`,
            note: 'term structure inverted: usually an event',
          }),
        );
      } else if (termRatio !== null) {
        reasons.push(info('vol.term', round(termRatio, 3), { threshold: `<= ${p.termBackwardationMax}` }));
      }
      if (skew !== null) {
        const skews = await ctx.data.skewHistory(365);
        const med = skews.length >= 20 ? median(skews) : null;
        if (med !== null && skew > med) {
          s += p.skewBonus;
          reasons.push(
            pass('vol.skew', round(skew, 4), {
              note: `25-delta skew above its 1-year median ${fmt(med, 4)}: small bonus`,
            }),
          );
        } else {
          reasons.push(
            info('vol.skew', round(skew, 4), {
              note:
                skews.length >= 20
                  ? 'not above its 1-year median'
                  : `only ${skews.length} stored skew points, no bonus`,
            }),
          );
        }
      }
      score = round(clamp(s, 0, 100), 1);
    }

    // ------- verdict
    // 1. Thin by both trailing measures (rank and trailing VRP): FAIL, unless the forward series says selling this
    //    name's IV has paid anyway, in which case it stays sellable with a size note (the old rule's false negative).
    const thinTrailing = ivrOk && vrpOk && (ivRank as number) < p.ivrMin && (vrp as number) < p.vrpMinRatio;
    if (thinTrailing && fwdPositive && vrpForward) {
      reasons.push(
        info(
          'vol.lowRankSize',
          `IV rank ${fmt(ivRank, 0)}, forward VRP ${vrpForward.above}/${vrpForward.observations}`,
          {
            note: 'premium is cheap by rank and trailing vol but implied has beaten the vol that followed: sellable, size smaller',
          },
        ),
      );
    } else if (thinTrailing) {
      reasons.push(
        fail('vol.noEdge', `IV rank ${fmt(ivRank, 0)}, trailing VRP ${fmt(vrp, 2)}`, {
          threshold: `IV rank >= ${p.ivrMin} or trailing VRP >= ${p.vrpMinRatio}${vrpForward ? ` or forward VRP positive in >= ${p.vrpPositiveMin} of ${vrpForward.observations}` : ''}`,
          note: `premium is neither rich nor above realised vol${vrpForward ? ` and the forward series (${vrpForward.above}/${vrpForward.observations} above) does not rescue it` : ''}`,
        }),
      );
    }
    // 2. Structurally negative forward VRP: the WARN above stands whatever the rank; with no dated result inside the
    //    expiry window there is no event premium to explain today's IV either, so it is a FAIL.
    if (fwdNegative && vrpForward) {
      const windowDays = optParams.dteMax[market];
      const upcoming = nextResults;
      const resultInside = upcoming !== undefined && diffDays(upcoming.date, ctx.asOf) <= windowDays;
      if (!resultInside && !reasons.some((r) => r.rule === 'vol.noEdge')) {
        reasons.push(
          fail('vol.noEdge', `forward VRP ${vrpForward.above}/${vrpForward.observations}`, {
            threshold: `implied below subsequent realised in fewer than ${p.vrpNegativeMin} of ${vrpForward.observations} windows, or a dated result inside the next ${windowDays} days`,
            note: `implied vol has trailed the vol that followed in ${vrpForward.observations - vrpForward.above} of ${vrpForward.observations} windows and ${upcoming ? `the next result (${upcoming.date}) is outside the expiry window` : 'no result date is known'}: IV rank ${fmt(ivRank, 0)} cannot lift it`,
          }),
        );
      }
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
      verdict: score === null && verdict === 'PASS' ? 'NA' : verdict,
      reasons,
      payload: {
        iv30,
        iv60,
        ivRank,
        ivPercentile,
        rv20,
        rv60,
        vrpRatio: vrp,
        vrpForward,
        rvRecent,
        termRatio,
        skew25d: skew,
        tier,
        ivSource,
        rankBasis,
        ivRvRatio: null,
        ivOrigin,
        daysToResults,
      },
      dataQuality: { tier: tier === 'real' && rankBasis === 'real' ? 'real' : 'proxy', missing },
    };
  },
};
