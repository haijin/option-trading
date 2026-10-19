/**
 * S8 leaders.pullback (docs/designs/leaders-pullback.md): is this name a market leader that has pulled back to a definable
 * support and is turning up, and what would the stop-first trade plan be. Pure analysis over the as-of-bounded DataAccess;
 * it is NOT part of the sell-put pipeline (the runner never calls it) and has its own scan job.
 *
 *   A  leader screen   history, price, liquidity, 1/3/6-month returns and their percentile ranks (ranks come from the job)
 *   B  consolidation   the base since the highest high of the last 60 bars: depth, length, contraction, volume dry-up
 *   C  support map     EMAs, swing points, open gaps, AVWAP from the range high and the base low; the level in play
 *   D  state           setup | watch | extended | broken | excluded
 *   E  trade plan      stop under the lower of today's and yesterday's low, shares from 0.5% risk, 3R and 5R
 *   F  score           0-100 from momentum, tightness, confluence, trigger and liquidity, less penalties
 *
 * Every number in a reason line is a payload field; there is no free text. Fractions are fractions (0.71 = +71%).
 */
import { diffDays, type ISODate } from '../core/dates';
import {
  LEVEL_FAMILY,
  type LeaderBase,
  type LeaderFlag,
  type LeaderLevel,
  type LeaderPlan,
  type LeaderPosture,
  type LeaderReached,
  type LeaderState,
  type LeadersPayload,
  type LeaderWhy,
  type LevelSource,
  RETURN_BARS,
  trailingReturn,
} from '../core/leaders';
import type { LeadersPullbackParams } from '../core/params';
import type { DailyBar, Reason } from '../core/types';
import { clamp, lerpScore, median, round } from '../core/util';
import { atr, avwap, ema, fractalHighs, fractalLows, rollingMean, unfilledGapUps } from '../indicators';
import { type AnalysisSkill, fail, info, pass, type SkillResult, warnData, warnRule } from './contract';
import { fmt, pctStr } from './helpers';
import type { RegimePayload } from './s0-market-regime';

/** What the scan publishes to the skill for one name (`ctx.extras[LEADERS_RANKS_KEY]`). Null ranks: the name was not screened. */
export interface LeadersRankInput {
  rank1m: number | null;
  rank3m: number | null;
  rank6m: number | null;
  /** Names in the rank table of this market, for the reason line. */
  screened: number;
}

/** The next earnings and ex-dividend dates, when the scan could look them up (`ctx.extras[LEADERS_EARNINGS_KEY]`). */
export interface LeadersEarningsInput {
  earnings: ISODate | null;
  exDividend: ISODate | null;
}

export const LEADERS_RANKS_KEY = 'leaders.ranks';
export const LEADERS_EARNINGS_KEY = 'leaders.earnings';
export const LEADERS_SKILL_ID = 'leaders.pullback';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d: ISODate): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? '?'}`;
const r4 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : round(x, 4));
const pct0 = (x: number): string => `${(x * 100).toFixed(0)}%`;
const signedPct0 = (x: number): string => `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(0)}%`;
const SIGNED_PTS = (x: number): string => `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(0)} pts`;

// ------------------------------------------------------------------------------------------------- stage A
export interface LeadersScreen {
  bars: number;
  close: number | null;
  dollarVol20: number | null;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  /** The history, price and liquidity rows. The name enters the rank table only when this is true. */
  eligible: boolean;
  /** The first failing row in words; null when eligible. */
  reason: string | null;
}

/** Stage A's history, price, liquidity and return rows: shared by the skill and by the job that builds the rank table. */
export function leadersScreen(
  bars: readonly DailyBar[],
  asOf: ISODate,
  market: 'US' | 'HK',
  p: LeadersPullbackParams,
): LeadersScreen {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const last = bars[n - 1];
  const dv = median(bars.slice(-20).map((b) => b.close * b.volume));
  const base = {
    bars: n,
    close: last ? last.close : null,
    dollarVol20: dv === null ? null : Math.round(dv),
    ret1m: trailingReturn(closes, RETURN_BARS.m1),
    ret3m: trailingReturn(closes, RETURN_BARS.m3),
    ret6m: trailingReturn(closes, RETURN_BARS.m6),
  };
  const ccy = market === 'HK' ? 'HK$' : 'US$';
  const millions = (x: number): string => `${ccy}${(x / 1e6).toFixed(0)}m`;
  let reason: string | null = null;
  if (n < p.minBars) reason = `history: ${n} bars, needs ${p.minBars}`;
  else if (!last || last.day !== asOf) reason = `no bar for ${asOf} (last ${last?.day ?? 'none'})`;
  else if (last.close < p.minPrice[market])
    reason = `price ${fmt(last.close)} below the ${ccy}${p.minPrice[market]} floor`;
  else if (dv === null || dv < p.minDollarVol[market])
    reason = `dollar volume ${dv === null ? 'n/a' : millions(dv)} a day, floor ${millions(p.minDollarVol[market])}`;
  else if (base.ret6m === null) reason = 'six-month return unavailable';
  return { ...base, eligible: reason === null, reason };
}

/** The leader rule from the returns and rank percentiles; the failing half in words when it is not met. */
export function leaderRule(
  s: Pick<LeadersScreen, 'ret3m' | 'ret6m'>,
  ranks: Pick<LeadersRankInput, 'rank1m' | 'rank3m' | 'rank6m'>,
  p: LeadersPullbackParams,
): { isLeader: boolean; reason: string | null } {
  const gain = (s.ret3m !== null && s.ret3m >= p.leaderMinGain) || (s.ret6m !== null && s.ret6m >= p.leaderMinGain);
  const above = [ranks.rank1m, ranks.rank3m, ranks.rank6m].filter((r) => r !== null && r >= p.leaderRankPct).length;
  if (!gain)
    return {
      isLeader: false,
      reason: `not a leader: 3m ${s.ret3m === null ? 'n/a' : signedPct0(s.ret3m)} and 6m ${s.ret6m === null ? 'n/a' : signedPct0(s.ret6m)}, neither reaches +${pct0(p.leaderMinGain)}`,
    };
  if (above < p.leaderWindowsNeeded)
    return {
      isLeader: false,
      reason: `not a leader: ranked in the top ${100 - p.leaderRankPct}% on ${above} of 3 windows, needs ${p.leaderWindowsNeeded}`,
    };
  return { isLeader: true, reason: null };
}

// -------------------------------------------------------------------------------------------------- helpers
function rangeOf(highs: readonly number[], lows: readonly number[], from: number, to: number): number {
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, highs[i] as number);
    lo = Math.min(lo, lows[i] as number);
  }
  return hi - lo;
}

function roundPrice(x: number): number {
  return x < 1 ? round(x, 4) : x < 10 ? round(x, 3) : round(x, 2);
}

function emptyPayload(asOf: ISODate): LeadersPayload {
  return {
    state: 'excluded',
    reached: 'screened',
    reason: null,
    asOf,
    close: null,
    prevClose: null,
    changePct: null,
    dollarVol20: null,
    bars: 0,
    ret1m: null,
    ret3m: null,
    ret6m: null,
    rank1m: null,
    rank3m: null,
    rank6m: null,
    isLeader: false,
    indexRet3m: null,
    rs3m: null,
    ema9: null,
    ema21: null,
    ema50: null,
    atr14: null,
    atrPct: null,
    avwapHigh: null,
    avwapLow: null,
    distEma21: null,
    distAvwapHigh: null,
    base: null,
    levels: [],
    inPlay: null,
    confluence: 0,
    turnUp: false,
    closePos: null,
    stopPct: null,
    plan: null,
    earningsInDays: null,
    earningsKnown: false,
    exDividendInDays: null,
    regime: null,
    posture: 'entries',
    score: 0,
    parts: { momentum: 0, tightness: 0, confluence: 0, trigger: 0, liquidity: 0, penalty: 0 },
    flags: [],
    why: [],
  };
}

const topPct = (rank: number): number => Math.max(1, Math.round(100 - rank));

// ------------------------------------------------------------------------------------------------- the skill
export const leadersPullback: AnalysisSkill<LeadersPayload> = {
  id: LEADERS_SKILL_ID,
  version: '1.0.0',
  dependsOn: ['market.regime'],
  paramKey: 'leaders.pullback',
  /**
   * One result per (instrument, asOf) like the other analysis skills. The scan job keeps its results in `leaders_candidates`
   * instead of `skill_runs`, because a result also depends on the market-wide rank table, which no single-instrument write
   * invalidates.
   */
  cacheable: true,

  async run(ctx): Promise<SkillResult<LeadersPayload>> {
    const p = ctx.params['leaders.pullback'];
    const market = ctx.instrument.market;
    const reasons: Reason[] = [];
    const missing: string[] = [];
    const payload = emptyPayload(ctx.asOf);
    const result = (
      state: LeaderState,
      score: number | null,
      tier: 'real' | 'proxy' = 'real',
    ): SkillResult<LeadersPayload> => ({
      skillId: this.id,
      version: this.version,
      score,
      verdict: state === 'setup' ? 'PASS' : state === 'watch' ? 'WARN' : 'NA',
      reasons,
      payload: { ...payload, state },
      dataQuality: { tier, missing },
    });
    /** A name that stops before the list: the state, the rule that stopped it and one line saying so. */
    const stop = (
      state: LeaderState,
      reached: LeaderReached,
      rule: string,
      reason: string,
      level: 'warn' | 'info' = 'info',
    ): SkillResult<LeadersPayload> => {
      payload.reached = reached;
      payload.reason = reason;
      payload.why = [{ level, text: reason.charAt(0).toUpperCase() + reason.slice(1) }];
      reasons.push(state === 'excluded' ? fail(rule, reason) : warnRule(rule, reason));
      return result(state, null);
    };

    const ranks = ctx.extras?.[LEADERS_RANKS_KEY] as LeadersRankInput | undefined;
    const bars = await ctx.data.bars(300);
    const screen = leadersScreen(bars, ctx.asOf, market, p);
    payload.bars = screen.bars;
    payload.close = r4(screen.close);
    payload.dollarVol20 = screen.dollarVol20;
    payload.ret1m = r4(screen.ret1m);
    payload.ret3m = r4(screen.ret3m);
    payload.ret6m = r4(screen.ret6m);

    if (!ranks) {
      missing.push('leaders.ranks');
      return stop('excluded', 'screened', 'leaders.ranks', 'no rank table: the scan did not publish the market ranks');
    }
    if (!screen.eligible) return stop('excluded', 'screened', 'leaders.screen', screen.reason as string);

    // -------------------------------------------------------------------- stage A: leader
    payload.rank1m = r4(ranks.rank1m);
    payload.rank3m = r4(ranks.rank3m);
    payload.rank6m = r4(ranks.rank6m);
    const market_ = await ctx.data.market();
    const ic = market_.indexBars.map((b) => b.close);
    const indexRet3m =
      ic.length > RETURN_BARS.m3
        ? (ic[ic.length - 1] as number) / (ic[ic.length - 1 - RETURN_BARS.m3] as number) - 1
        : null;
    payload.indexRet3m = r4(indexRet3m);
    payload.rs3m = screen.ret3m !== null && indexRet3m !== null ? r4(screen.ret3m - indexRet3m) : null;
    const leader = leaderRule(screen, ranks, p);
    payload.isLeader = leader.isLeader;
    if (!leader.isLeader) return stop('excluded', 'screened', 'leaders.leader', leader.reason as string);
    reasons.push(
      pass('leaders.leader', `3m ${pctStr(screen.ret3m)}, 6m ${pctStr(screen.ret6m)}`, {
        threshold: `>= +${pct0(p.leaderMinGain)} and top ${100 - p.leaderRankPct}% on ${p.leaderWindowsNeeded} of 3 windows`,
        note: `ranks p${fmt(ranks.rank1m, 0)} / p${fmt(ranks.rank3m, 0)} / p${fmt(ranks.rank6m, 0)} of ${ranks.screened} names`,
      }),
    );

    const n = bars.length;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    const opens = bars.map((b) => b.open);
    const vols = bars.map((b) => b.volume);
    const close = closes[n - 1] as number;
    const prevClose = closes[n - 2] as number;
    const high = highs[n - 1] as number;
    const low = lows[n - 1] as number;
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);
    const atr14s = atr(highs, lows, closes, 14);
    const ema9 = e9[n - 1] ?? null;
    const ema21 = e21[n - 1] ?? null;
    const ema50 = e50[n - 1] ?? null;
    const atr14 = atr14s[n - 1] ?? null;
    payload.prevClose = r4(prevClose);
    payload.changePct = r4(close / prevClose - 1);
    payload.ema9 = r4(ema9);
    payload.ema21 = r4(ema21);
    payload.ema50 = r4(ema50);
    payload.atr14 = r4(atr14);
    payload.atrPct = atr14 === null ? null : r4(atr14 / close);
    payload.distEma21 = ema21 === null ? null : r4(close / ema21 - 1);

    // regime and posture (S0 is a prior skill)
    const s0 = ctx.data.priorSkillResult<RegimePayload>('market.regime')?.payload;
    if (!s0) missing.push('market.regime');
    const regime = s0?.regime ?? null;
    const posture: LeaderPosture = regime === 'panic' || regime === 'crash_guard' ? 'watch_only' : 'entries';
    payload.regime = regime;
    payload.posture = posture;

    // earnings and ex-dividend: the scan's lookup when it made one, else the stored calendar
    let earningsDate: ISODate | null = null;
    let exDivDate: ISODate | null = null;
    const looked = ctx.extras?.[LEADERS_EARNINGS_KEY] as LeadersEarningsInput | undefined;
    if (looked) {
      earningsDate = looked.earnings;
      exDivDate = looked.exDividend;
    } else {
      const events = (await ctx.data.calendar()).events;
      const next = (type: string): ISODate | null =>
        events
          .filter((e) => e.type === type && e.date >= ctx.asOf)
          .map((e) => e.date)
          .sort()[0] ?? null;
      earningsDate = next('earnings');
      exDivDate = next('ex_dividend');
    }
    const earningsInDays = earningsDate && earningsDate >= ctx.asOf ? diffDays(earningsDate, ctx.asOf) : null;
    payload.earningsInDays = earningsInDays;
    payload.earningsKnown = earningsInDays !== null;
    payload.exDividendInDays = exDivDate && exDivDate >= ctx.asOf ? diffDays(exDivDate, ctx.asOf) : null;
    if (earningsInDays === null) missing.push('earnings');

    // -------------------------------------------------------------------- stage B: the base
    const start = Math.max(0, n - p.baseLookback);
    let anchor = start;
    for (let i = start; i < n; i++) if ((highs[i] as number) >= (highs[anchor] as number)) anchor = i;
    const len = n - 1 - anchor;
    const anchorHigh = highs[anchor] as number;
    let baseLow = Number.POSITIVE_INFINITY;
    let baseLowIdx = anchor;
    for (let i = anchor; i < n; i++) {
      if ((lows[i] as number) <= baseLow) {
        baseLow = lows[i] as number;
        baseLowIdx = i;
      }
    }
    const priorBaseLow = Math.min(...lows.slice(anchor, n - 1));
    const depth = (anchorHigh - baseLow) / anchorHigh;
    const r10 = rangeOf(highs, lows, n - 10, n - 1);
    const r20 = rangeOf(highs, lows, n - 20, n - 1);
    const contraction = r20 > 0 ? r10 / r20 : null;
    const vol10 = rollingMean(vols, 10)[n - 1] ?? null;
    const vol50 = rollingMean(vols, 50)[n - 1] ?? null;
    const volDryUp = vol10 !== null && vol50 !== null && vol50 > 0 ? vol10 / vol50 : null;
    const atrAtHigh = atr14s[anchor] ?? null;
    const atrRatio = atr14 !== null && atrAtHigh !== null && atrAtHigh > 0 ? atr14 / atrAtHigh : null;
    const base: LeaderBase = {
      anchorDay: bars[anchor]?.day as ISODate,
      anchorHigh: r4(anchorHigh) as number,
      baseLow: r4(baseLow) as number,
      depth: r4(depth) as number,
      len,
      contraction: r4(contraction),
      volDryUp: r4(volDryUp),
      atrRatio: r4(atrRatio),
    };
    payload.base = base;
    payload.reached = 'leaders';
    if (len < p.baseMinLen)
      return stop(
        'excluded',
        'leaders',
        'leaders.base',
        `no base yet: the range high was ${len === 0 ? 'today' : `${len} day${len === 1 ? '' : 's'} ago`}, a base needs ${p.baseMinLen}`,
      );
    if (len > p.baseMaxLen)
      return stop('excluded', 'leaders', 'leaders.base', `base ${len} days long, limit ${p.baseMaxLen}`);
    if (depth > p.depthMax)
      return stop('excluded', 'leaders', 'leaders.base', `base ${pct0(depth)} deep, limit ${pct0(p.depthMax)}`);
    if (depth < p.depthMin)
      return stop(
        'excluded',
        'leaders',
        'leaders.base',
        `base only ${pct0(depth)} deep, a pullback needs ${pct0(p.depthMin)}`,
      );
    if (contraction !== null && contraction > p.contractionCap)
      return stop(
        'excluded',
        'leaders',
        'leaders.base',
        `range expanding: the 10-day range is ${pct0(contraction)} of the 20-day, limit ${pct0(p.contractionCap)}`,
      );
    reasons.push(
      pass('leaders.base', `${pct0(depth)} deep over ${len} days`, {
        threshold: `${pct0(p.depthMin)}-${pct0(p.depthMax)} deep, ${p.baseMinLen}-${p.baseMaxLen} days`,
        note: `range ${contraction === null ? 'n/a' : pct0(contraction)} of 20d, volume ${volDryUp === null ? 'n/a' : pct0(volDryUp)} of 50d`,
      }),
    );

    // -------------------------------------------------------------------- stage C: support map
    const aH = avwap(highs, lows, closes, vols, anchor);
    const aL = avwap(highs, lows, closes, vols, baseLowIdx);
    const avwapHigh = aH[n - 1] ?? null;
    const avwapLow = aL[n - 1] ?? null;
    payload.avwapHigh = r4(avwapHigh);
    payload.avwapLow = r4(avwapLow);
    payload.distAvwapHigh = avwapHigh === null ? null : r4(close / avwapHigh - 1);

    const levels: LeaderLevel[] = [];
    const add = (source: LevelSource, label: string, level: number | null): void => {
      if (level === null || !Number.isFinite(level) || level <= 0) return;
      levels.push({
        source,
        label,
        level: r4(level) as number,
        distPct: r4(close / level - 1) as number,
        inPlay: false,
      });
    };
    add('ema9', 'EMA 9', ema9);
    add('ema21', 'EMA 21', ema21);
    add('ema50', 'EMA 50', ema50);
    add('avwap_high', 'AVWAP from range high', avwapHigh);
    add('avwap_low', 'AVWAP from base low', avwapLow);
    add('base_low', 'Base low', baseLow);
    const from120 = Math.max(0, n - 120);
    const swingLows = fractalLows(lows);
    const swingHighs = fractalHighs(highs);
    let bestSwingLow: { i: number; v: number } | null = null;
    let bestSwingHigh: { i: number; v: number } | null = null;
    for (let i = from120; i < n - 2; i++) {
      const sl = swingLows[i];
      if (sl !== null && sl !== undefined && sl <= close && (!bestSwingLow || sl > bestSwingLow.v))
        bestSwingLow = { i, v: sl };
      const sh = swingHighs[i];
      if (sh !== null && sh !== undefined && sh <= close && (!bestSwingHigh || sh > bestSwingHigh.v))
        bestSwingHigh = { i, v: sh };
    }
    if (bestSwingLow)
      add('swing_low', `Prior swing low ${dayLabel(bars[bestSwingLow.i]?.day as ISODate)}`, bestSwingLow.v);
    if (bestSwingHigh)
      add('swing_high', `Prior swing high ${dayLabel(bars[bestSwingHigh.i]?.day as ISODate)}`, bestSwingHigh.v);
    const gaps = unfilledGapUps(highs, lows, 120);
    const openGaps: { i: number; v: number }[] = [];
    gaps.forEach((v, i) => {
      if (v !== null && v <= close) openGaps.push({ i, v });
    });
    openGaps.sort((a, b) => b.v - a.v);
    for (const g of openGaps.slice(0, 2)) add('gap', `Unfilled gap ${dayLabel(bars[g.i]?.day as ISODate)} (top)`, g.v);

    // support in play: a low of the last 3 bars came within tolerance of the level, and no close since is more than 1 ATR under it
    const lookbackBars = [n - 3, n - 2, n - 1].filter((i) => i >= 0);
    const minLow3 = Math.min(...lookbackBars.map((i) => lows[i] as number));
    const tolOf = (level: number): number =>
      Math.max(p.supportTolerancePct * level, atr14 === null ? 0 : p.supportToleranceAtr * atr14);
    const atrStop = atr14 ?? 0;
    const inPlayCandidates = levels.filter((l) => {
      if (l.level > close) return false;
      const touch = lookbackBars.find((i) => (lows[i] as number) <= l.level + tolOf(l.level));
      if (touch === undefined) return false;
      return lookbackBars.filter((i) => i >= touch).every((i) => (closes[i] as number) >= l.level - atrStop);
    });
    inPlayCandidates.sort((a, b) => Math.abs(minLow3 - a.level) - Math.abs(minLow3 - b.level));
    const inPlay = inPlayCandidates[0] ?? null;
    if (inPlay) inPlay.inPlay = true;
    levels.sort((a, b) => a.distPct - b.distPct);
    let confluence = 0;
    if (inPlay) {
      const families = new Set(
        levels
          .filter((l) => Math.abs(l.level / inPlay.level - 1) <= p.supportTolerancePct)
          .map((l) => LEVEL_FAMILY[l.source]),
      );
      families.add(LEVEL_FAMILY[inPlay.source]);
      confluence = families.size;
    }
    payload.levels = levels;
    payload.inPlay = inPlay;
    payload.confluence = confluence;

    // -------------------------------------------------------------------- stage D: state
    reasons.push(
      inPlay
        ? pass('leaders.support', inPlay.label, {
            note: `confluence ${confluence}; low ${fmt(minLow3)} within tolerance of ${fmt(inPlay.level)}`,
          })
        : info('leaders.support', 'none', { note: 'no level was touched in the last 3 bars' }),
    );
    payload.reached = 'consolidating';
    if (ema50 !== null && close < ema50)
      return stop('broken', 'leaders', 'leaders.broken', `closed below the 50-EMA (${fmt(ema50)})`, 'warn');
    if (close < priorBaseLow)
      return stop('broken', 'leaders', 'leaders.broken', `closed below the base low (${fmt(priorBaseLow)})`, 'warn');
    const extendedBy = ema21 === null ? null : close / ema21 - 1;
    const extendedAtr = ema21 !== null && atr14 !== null && atr14 > 0 ? (close - ema21) / atr14 : null;
    if (extendedBy !== null && ((extendedAtr !== null && extendedAtr > p.extendedAtr) || extendedBy > p.extendedPct))
      return stop(
        'extended',
        'consolidating',
        'leaders.extended',
        `extended: ${pct0(extendedBy)} above the 21-EMA${extendedAtr === null ? '' : ` (${extendedAtr.toFixed(1)} ATR)`}`,
      );

    const range = high - low;
    const closePos = range > 0 ? (close - low) / range : null;
    payload.closePos = r4(closePos);
    const reclaim = (ema21 !== null && close >= ema21) || (avwapHigh !== null && close >= avwapHigh);
    const turnUpBar =
      close > (opens[n - 1] as number) && closePos !== null && closePos >= 0.5 && close > prevClose && reclaim;
    const turnUp = turnUpBar && inPlay !== null;
    payload.turnUp = turnUp;

    // the stop and the plan a turn-up bar would carry
    const stopPrice = Math.min(low, lows[n - 2] as number) * (1 - p.stopBufferPct);
    const stopPct = (close - stopPrice) / close;
    if (turnUp) payload.stopPct = r4(stopPct);

    let state: LeaderState = 'watch';
    let demotion: string | null = null;
    if (turnUp) {
      if (posture === 'watch_only') demotion = `regime ${regime}: pullback entries are off, shown as Watch`;
      else if (earningsInDays !== null && earningsInDays <= p.earningsBlackoutDays)
        demotion = `earnings in ${earningsInDays} day${earningsInDays === 1 ? '' : 's'}, inside the ${p.earningsBlackoutDays}-day blackout`;
      else if (stopPct > p.stopMaxPct)
        demotion = `the turn-up bar needs a ${(stopPct * 100).toFixed(1)}% stop, above the ${pct0(p.stopMaxPct)} cap`;
      else state = 'setup';
    }
    // a demotion that exists without a turn-up bar still applies to the score and the flags
    const blackout = earningsInDays !== null && earningsInDays <= p.earningsBlackoutDays;

    // plan (a Setup only)
    let plan: LeaderPlan | null = null;
    const instrument = ctx.instrument;
    const stockLot = instrument.providerSymbols.stockLot;
    const lot = market === 'US' ? 1 : typeof stockLot === 'number' && stockLot > 0 ? stockLot : instrument.multiplier;
    const lotAssumed = market === 'HK' && !(typeof stockLot === 'number' && stockLot > 0);
    if (state === 'setup') {
      const rPrice = close - stopPrice;
      const equity = ctx.portfolio.equity;
      const fx = ctx.portfolio.fxToBase(instrument.currency);
      const equityLocal = equity !== null && fx !== null && fx > 0 ? equity / fx : null;
      const riskBudget = equityLocal === null ? null : equityLocal * p.riskPctPerTrade;
      let shares: number | null = null;
      let lotTooBig = false;
      if (riskBudget !== null) {
        shares = Math.floor(Math.floor(riskBudget / rPrice) / lot) * lot;
        if (shares <= 0) {
          shares = lot;
          lotTooBig = true;
        }
      }
      plan = {
        entry: roundPrice(close),
        altEntry: roundPrice(high * 1.001),
        stop: roundPrice(stopPrice),
        stopPct: r4(stopPct) as number,
        r: roundPrice(rPrice),
        riskBudget: riskBudget === null ? null : Math.round(riskBudget),
        shares,
        riskAtStop: shares === null ? null : Math.round(shares * rPrice),
        positionValue: shares === null ? null : Math.round(shares * close),
        pctOfEquity: shares === null || equityLocal === null ? null : r4((shares * close) / equityLocal),
        r3: roundPrice(close + 3 * rPrice),
        r5: roundPrice(close + 5 * rPrice),
        lot,
        lotTooBig,
        lotRiskPct: equityLocal === null ? null : r4((lot * rPrice) / equityLocal),
      };
      payload.plan = plan;
    }

    // -------------------------------------------------------------------- stage F: score
    const w = p.weights;
    const rankMean = ((ranks.rank1m ?? 0) + (ranks.rank3m ?? 0) + (ranks.rank6m ?? 0)) / 3;
    const momentum = w.momentum * clamp((rankMean - 50) / 50, 0, 1);
    const tight = [
      contraction === null ? 0 : lerpScore(contraction, p.contractionScore, p.contractionBest) / 100,
      volDryUp === null ? 0 : lerpScore(volDryUp, p.volDryUpScore, p.volDryUpBest) / 100,
      atrRatio === null ? 0 : lerpScore(atrRatio, p.atrRatioScore, p.atrRatioBest) / 100,
    ];
    const tightness = w.tightness * (tight.reduce((a, b) => a + b, 0) / tight.length);
    const confTable = [0, 8, 14, 20];
    const confRaw =
      (confTable[Math.min(confluence, 3)] as number) +
      (inPlay && reclaim && avwapHigh !== null && close >= avwapHigh ? 4 : 0);
    const confluenceScore = w.confluence * (Math.min(20, confRaw) / 20);
    let trigger = 0;
    if (state === 'setup' && closePos !== null) {
      const stopTightness = 0.5 + 0.5 * clamp((p.stopMaxPct - stopPct) / (p.stopMaxPct - 0.01), 0, 1);
      trigger = w.trigger * closePos * stopTightness;
    }
    const dvFull = Math.min(1, (screen.dollarVol20 ?? 0) / (2 * p.minDollarVol[market]));
    const liquidity = w.liquidity * ((2 / 3) * dvFull + (1 / 3) * (payload.rs3m !== null && payload.rs3m > 0 ? 1 : 0));
    const pen = p.penalties;
    const stopIsWide = stopPct >= p.stopTightPct && turnUp;
    const penalty =
      (blackout ? pen.earnings : 0) +
      (stopIsWide ? pen.stopWide : 0) +
      (plan?.lotTooBig ? pen.lotTooBig : 0) +
      (posture === 'watch_only' ? pen.watchOnly : 0);
    const raw = momentum + tightness + confluenceScore + trigger + liquidity;
    payload.score = round(clamp(raw - penalty, 0, 100), 1);
    payload.parts = {
      momentum: round(momentum, 1),
      tightness: round(tightness, 1),
      confluence: round(confluenceScore, 1),
      trigger: round(trigger, 1),
      liquidity: round(liquidity, 1),
      penalty: round(penalty, 1),
    };

    // -------------------------------------------------------------------- reasons, flags, the three lines
    const why: LeaderWhy[] = [];
    {
      const t3 = ranks.rank3m === null ? null : topPct(ranks.rank3m);
      const t6 = ranks.rank6m === null ? null : topPct(ranks.rank6m);
      const rs = payload.rs3m === null ? '' : `; RS vs ${market_.indexSymbol} ${SIGNED_PTS(payload.rs3m)}`;
      why.push({
        level: 'pass',
        text: `Top ${t3 ?? '?'}% on 3m (${signedPct0(screen.ret3m as number)}) and top ${t6 ?? '?'}% on 6m (${signedPct0(screen.ret6m as number)})${rs}`,
      });
    }
    {
      const tidy =
        contraction !== null && contraction <= p.contractionScore && volDryUp !== null && volDryUp <= p.volDryUpScore;
      const loose = depth >= 0.2 || len >= 35 || (volDryUp !== null && volDryUp > p.volDryUpScore);
      why.push({
        level: tidy ? 'pass' : loose ? 'warn' : 'info',
        text: `Base ${pct0(depth)} deep over ${len} days, 10-day range ${contraction === null ? 'n/a' : pct0(contraction)} of the 20-day, volume ${volDryUp === null ? 'n/a' : pct0(volDryUp)} of its 50-day`,
      });
    }
    {
      let line: LeaderWhy;
      if (state === 'setup' && inPlay && closePos !== null) {
        const where = closePos >= 2 / 3 ? 'top third' : 'upper half';
        line = {
          level: stopPct >= p.stopTightPct ? 'warn' : 'pass',
          text: `Turn-up bar: closed in the ${where} of its range off ${inPlay.label}${confluence > 1 ? ` (confluence ${confluence})` : ''}; stop ${(stopPct * 100).toFixed(1)}%${stopPct >= p.stopTightPct ? ', inside the cap but wide' : ''}`,
        };
      } else if (turnUp && demotion) {
        line = { level: 'warn', text: `Turn-up bar printed, but ${demotion}` };
      } else if (inPlay) {
        line = {
          level: 'info',
          text: `No turn-up bar yet: ${closePos !== null && closePos < 0.5 ? 'closed in the lower half of its range' : 'the close did not reclaim the 21-EMA or AVWAP on an up day'}; ${inPlay.label} is in play`,
        };
      } else {
        const nearest = levels.filter((l) => l.level <= close).sort((a, b) => a.distPct - b.distPct)[0];
        line = {
          level: 'info',
          text: nearest
            ? `Waiting for a touch: nearest support ${nearest.label} is ${(nearest.distPct * 100).toFixed(1)}% below`
            : 'Waiting for a touch of support',
        };
      }
      why.push(line);
    }
    payload.why = why;

    const flags: LeaderFlag[] = [];
    if (earningsInDays === null) flags.push({ level: 'warn', text: 'Earnings date unknown' });
    else if (earningsInDays <= p.earningsBlackoutDays)
      flags.push({ level: 'fail', text: `Earnings in ${earningsInDays} d · blackout` });
    else if (earningsInDays <= 14) flags.push({ level: 'warn', text: `Earnings in ${earningsInDays} d` });
    if (payload.exDividendInDays !== null && payload.exDividendInDays <= 7)
      flags.push({ level: 'warn', text: `Ex-dividend in ${payload.exDividendInDays} d` });
    if (payload.stopPct !== null && payload.stopPct > p.stopMaxPct)
      flags.push({ level: 'fail', text: `Stop ${(payload.stopPct * 100).toFixed(1)}% > ${pct0(p.stopMaxPct)} cap` });
    else if (payload.stopPct !== null && payload.stopPct >= p.stopTightPct)
      flags.push({ level: 'warn', text: `Stop ${(payload.stopPct * 100).toFixed(1)}% wide` });
    if (plan?.lotTooBig && plan.lotRiskPct !== null)
      flags.push({ level: 'warn', text: `1 lot risks ${(plan.lotRiskPct * 100).toFixed(2)}%` });
    if (market === 'HK' && lotAssumed) flags.push({ level: 'warn', text: 'Board lot unverified' });
    if (depth >= 0.2) flags.push({ level: 'warn', text: `Base ${pct0(depth)} deep` });
    if (s0 && s0.indexVsSma200Pct !== null && s0.indexVsSma200Pct < 0)
      flags.push({ level: 'warn', text: 'Index below its 200-day' });
    if (posture === 'watch_only') flags.push({ level: 'fail', text: `Regime ${regime}: watch only` });
    payload.flags = flags;

    reasons.push(
      turnUp
        ? pass('leaders.trigger', true, {
            note: `close in the ${(closePos as number) >= 2 / 3 ? 'top third' : 'upper half'} of the range, above the prior close`,
          })
        : info('leaders.trigger', false, { note: 'no turn-up bar today' }),
    );
    if (turnUp)
      reasons.push(
        stopPct <= p.stopMaxPct
          ? (stopPct >= p.stopTightPct ? warnRule : pass)('leaders.stop', pctStr(stopPct), {
              threshold: `<= ${pct0(p.stopMaxPct)}`,
              note: `stop ${fmt(stopPrice)} under the lower of today's and yesterday's low`,
            })
          : fail('leaders.stop', pctStr(stopPct), {
              threshold: `<= ${pct0(p.stopMaxPct)}`,
              note: 'the stop is wider than the cap: shown as Watch',
            }),
      );
    reasons.push(
      earningsInDays === null
        ? warnData('leaders.earnings', 'unknown', { note: 'no earnings date in our data' })
        : earningsInDays <= p.earningsBlackoutDays
          ? warnRule('leaders.earnings', earningsInDays, {
              threshold: `> ${p.earningsBlackoutDays} days`,
              note: 'inside the blackout: shown as Watch',
            })
          : pass('leaders.earnings', earningsInDays, { threshold: `> ${p.earningsBlackoutDays} days` }),
    );
    if (posture === 'watch_only')
      reasons.push(
        warnRule('leaders.regime', regime, {
          note: 'pullback entries are off in this regime: every Setup shows as Watch',
        }),
      );
    if (demotion && state !== 'setup') payload.reason = demotion;

    payload.state = state;
    return result(state, payload.score, s0 ? 'real' : 'proxy');
  },
};
