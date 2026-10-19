import { addDays, monthOf, yearOf, ymd } from '../core/dates';
import type { DailyBar, Reason } from '../core/types';
import { clamp, round } from '../core/util';
import { adx, atr, bollinger, donchian, fractalLows, macd, rollingMean, rsi, sma } from '../indicators';
import { type AnalysisSkill, fail, info, pass, type SkillResult, warnData, warnRule } from './contract';
import { at, fmt, lastOf, pctStr } from './helpers';

export interface TechnicalPayload {
  close: number | null;
  support: number | null;
  supportSource: string;
  atr14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macdHist: number | null;
  bbLower: number | null;
  adx14: number | null;
  plusDi: number | null;
  minusDi: number | null;
  donchian20: { upper: number | null; lower: number | null };
  donchian55: { upper: number | null; lower: number | null };
  ret3m: number | null;
  indexRet3m: number | null;
  pctFrom52wHigh: number | null;
  pctFrom52wLow: number | null;
  trendState: 'up' | 'down' | 'side' | null;
  supportCandidates: { source: string; level: number }[];
  components: Record<string, { ratio: number | null; weight: number }>;
}

/** Series published for S3/S4 so indicators are computed once per (instrument, asOf). */
export interface TaSeries {
  closes: number[];
  highs: number[];
  lows: number[];
  opens: number[];
  volumes: number[];
  days: string[];
}

export const TA_SERIES_KEY = 'ta.series';
const MIN_BARS = 30;

export function buildTaSeries(bars: DailyBar[]): TaSeries {
  return {
    closes: bars.map((b) => b.close),
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
    opens: bars.map((b) => b.open),
    volumes: bars.map((b) => b.volume),
    days: bars.map((b) => b.day),
  };
}

function priorMonthLow(series: TaSeries, asOf: string): number | null {
  const y = yearOf(asOf);
  const m = monthOf(asOf);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const from = ymd(py, pm, 1);
  const to = addDays(ymd(y, m, 1), -1);
  let lo: number | null = null;
  series.days.forEach((d, i) => {
    if (d >= from && d <= to) lo = lo === null ? (series.lows[i] as number) : Math.min(lo, series.lows[i] as number);
  });
  return lo;
}

export const technicalTiming: AnalysisSkill<TechnicalPayload> = {
  id: 'technical.timing',
  version: '1.0.0',
  dependsOn: [],
  paramKey: 'technical.timing',
  cacheable: true,

  async run(ctx): Promise<SkillResult<TechnicalPayload>> {
    const p = ctx.params['technical.timing'];
    const bars = await ctx.data.bars(300);
    const market = await ctx.data.market();
    const reasons: Reason[] = [];
    const missing: string[] = [];

    const empty: TechnicalPayload = {
      close: null,
      support: null,
      supportSource: 'none',
      atr14: null,
      sma20: null,
      sma50: null,
      sma200: null,
      rsi14: null,
      macdHist: null,
      bbLower: null,
      adx14: null,
      plusDi: null,
      minusDi: null,
      donchian20: { upper: null, lower: null },
      donchian55: { upper: null, lower: null },
      ret3m: null,
      indexRet3m: null,
      pctFrom52wHigh: null,
      pctFrom52wLow: null,
      trendState: null,
      supportCandidates: [],
      components: {},
    };

    if (bars.length < MIN_BARS) {
      reasons.push(
        warnData('technical.insufficientBars', bars.length, {
          threshold: `>= ${MIN_BARS} bars`,
          note: 'technical timing not scored',
        }),
      );
      return {
        skillId: this.id,
        version: this.version,
        score: null,
        verdict: 'NA',
        reasons,
        payload: empty,
        dataQuality: { tier: 'proxy', missing: ['bars'] },
      };
    }

    const s = ctx.data.memo(TA_SERIES_KEY, () => buildTaSeries(bars));
    const n = s.closes.length;
    const close = s.closes[n - 1] as number;

    const sma20 = lastOf(sma(s.closes, 20));
    const sma50Series = sma(s.closes, 50);
    const sma50 = lastOf(sma50Series);
    const sma200 = lastOf(sma(s.closes, 200));
    const atr14 = lastOf(atr(s.highs, s.lows, s.closes, 14));
    const bb = bollinger(s.closes, 20, 2);
    const bbLowerSeries = bb.lower;
    const bbLower = lastOf(bbLowerSeries);
    const adxR = adx(s.highs, s.lows, s.closes, 14);
    const adx14 = lastOf(adxR.adx);
    const plusDi = lastOf(adxR.plusDi);
    const minusDi = lastOf(adxR.minusDi);
    const d20 = donchian(s.highs, s.lows, 20);
    const d55 = donchian(s.highs, s.lows, 55);
    const m = macd(s.closes, 12, 26, 9);
    // TA-Lib returns RSI 0 on a perfectly flat window: that is "no data", not "oversold".
    const flat = n >= 15 && s.closes.slice(-15).every((c) => c === s.closes[n - 1]);
    const rsiSeries = rsi(s.closes, 14);
    const rsi14 = flat ? null : lastOf(rsiSeries);

    if (sma200 === null) missing.push('sma200');
    if (atr14 === null) missing.push('atr14');
    if (rsi14 === null) missing.push('rsi14');

    // ------- support = highest candidate below spot
    const swingFractals = fractalLows(s.lows);
    let swingLow: number | null = null;
    for (let i = Math.max(0, n - 20); i <= n - 3; i++) {
      const v = swingFractals[i];
      if (v !== null && v !== undefined) swingLow = swingLow === null ? v : Math.min(swingLow, v);
    }
    if (swingLow === null) swingLow = Math.min(...s.lows.slice(-20));
    const candidates: { source: string; level: number | null }[] = [
      { source: 'swing-low-20d', level: swingLow },
      { source: 'sma50', level: sma50 },
      { source: 'sma200', level: sma200 },
      { source: 'prior-month-low', level: priorMonthLow(s, ctx.asOf) },
      { source: 'bollinger-lower', level: bbLower },
    ];
    const below = candidates.filter((c): c is { source: string; level: number } => c.level !== null && c.level < close);
    let support: number | null;
    let supportSource: string;
    if (below.length > 0) {
      const best = below.reduce((a, b) => (b.level > a.level ? b : a));
      support = best.level;
      supportSource = best.source;
    } else if (atr14 !== null) {
      support = close - p.syntheticSupportAtr * atr14;
      supportSource = 'synthetic';
      reasons.push(
        warnData('support.synthetic', round(support, 2), {
          note: `no level below spot: spot - ${p.syntheticSupportAtr} x ATR`,
        }),
      );
    } else {
      support = null;
      supportSource = 'none';
      missing.push('support');
    }

    // ------- returns and positions
    const ret3m = n > 63 ? close / (s.closes[n - 64] as number) - 1 : null;
    const ic = market.indexBars.map((b) => b.close);
    const indexRet3m = ic.length > 63 ? (ic[ic.length - 1] as number) / (ic[ic.length - 64] as number) - 1 : null;
    const hi52 = Math.max(...s.highs.slice(-252));
    const lo52 = Math.min(...s.lows.slice(-252));
    const slopeBack = p.sma50SlopeDays;
    const sma50Prev = at(sma50Series, slopeBack);
    const sma50Rising = sma50 !== null && sma50Prev !== null ? sma50 - sma50Prev >= 0 : null;
    let trendState: 'up' | 'down' | 'side' | null = null;
    if (sma200 !== null && sma50Rising !== null) {
      trendState = close > sma200 && sma50Rising ? 'up' : close < sma200 && !sma50Rising ? 'down' : 'side';
    }

    // ------- components (ratio 0..1, null when the input is missing: weights renormalise)
    const comps: Record<string, { ratio: number | null; weight: number }> = {};
    const put = (name: keyof typeof p.weights, ratio: number | null, reason: Reason) => {
      comps[name] = { ratio, weight: p.weights[name] };
      reasons.push({ ...reason, weight: p.weights[name] });
    };

    // trend
    {
      let ratio: number | null = null;
      if (sma200 !== null) ratio = close > sma200 ? (sma50Rising === false ? 0.5 : 1) : 0;
      put('trend', ratio, {
        rule: 'technical.trend',
        value:
          sma200 === null
            ? 'n/a'
            : `close ${fmt(close)} vs SMA200 ${fmt(sma200)}, SMA50 ${sma50Rising === null ? 'n/a' : sma50Rising ? 'rising' : 'falling'}`,
        threshold: 'close > SMA200 and SMA50 slope >= 0',
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }
    // pullback
    {
      let ratio: number | null = null;
      let touched = false;
      for (let i = Math.max(0, n - p.bbTouchDays); i < n; i++) {
        const lb = bbLowerSeries[i];
        if (lb !== null && lb !== undefined && (s.lows[i] as number) <= lb) touched = true;
      }
      if (rsi14 !== null) {
        if ((rsi14 >= p.rsiLo && rsi14 <= p.rsiHi) || touched) ratio = 1;
        else if (rsi14 < p.rsiLo || rsi14 <= 55) ratio = 0.5;
        else ratio = 0;
      } else if (touched) ratio = 1;
      put('pullback', ratio, {
        rule: 'technical.pullback',
        value: `RSI ${fmt(rsi14, 1)}${touched ? ', touched lower Bollinger' : ''}`,
        threshold: `RSI ${p.rsiLo}-${p.rsiHi} or Bollinger touch within ${p.bbTouchDays}d`,
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }
    // support distance
    {
      let ratio: number | null = null;
      let dist: number | null = null;
      if (support !== null && atr14 !== null && atr14 > 0) {
        dist = (close - support) / atr14;
        ratio = clamp(dist / p.supportAtrMin, 0, 1);
      }
      put('support', ratio, {
        rule: 'technical.supportDistance',
        value: dist === null ? 'n/a' : `${fmt(dist, 2)} ATR to support ${fmt(support)} (${supportSource})`,
        threshold: `>= ${p.supportAtrMin} ATR`,
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }
    // momentum
    {
      const h = m.hist;
      const h0 = at(h, 0);
      const h1 = at(h, 1);
      const h2 = at(h, 2);
      const h3 = at(h, 3);
      let ratio: number | null = null;
      if (h0 !== null && h1 !== null) {
        const rises = [h0 > h1, h1 !== null && h2 !== null && h1 > h2, h2 !== null && h3 !== null && h2 > h3];
        const run = rises[0] ? (rises[1] ? (rises[2] ? 3 : 2) : 1) : 0;
        ratio = run >= 3 ? 1 : run === 2 ? 0.5 : 0;
        const r0 = at(rsiSeries, 0);
        const r1 = at(rsiSeries, 1);
        if (!flat && r0 !== null && r1 !== null && r0 > r1 && r1 < 40) ratio = 1;
      }
      put('momentum', ratio, {
        rule: 'technical.momentum',
        value: `MACD hist ${fmt(h0, 3)}`,
        threshold: 'histogram rising 3 days, or RSI turning up from below 40',
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }
    // volume (no distribution)
    {
      const avg20 = rollingMean(s.volumes, 20);
      let ratio: number | null = 1;
      let spikes = 0;
      let examined = 0;
      for (let i = Math.max(1, n - 10); i < n; i++) {
        const a = avg20[i];
        if (a === null || a === undefined || a <= 0) continue;
        examined++;
        if ((s.closes[i] as number) < (s.closes[i - 1] as number) && (s.volumes[i] as number) > p.volSpikeMult * a)
          spikes++;
      }
      if (examined === 0) {
        ratio = null;
        missing.push('volume');
      } else if (spikes > 0) ratio = 0;
      put('volume', ratio, {
        rule: 'technical.volume',
        value: examined === 0 ? 'n/a' : `${spikes} heavy down-day(s) in last 10`,
        threshold: `down-day volume <= ${p.volSpikeMult}x 20d average`,
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }
    // relative strength
    {
      let ratio: number | null = null;
      if (ret3m !== null && indexRet3m !== null) {
        const rel = ret3m - indexRet3m;
        ratio = clamp((rel - (p.rsVsIndexMin - 0.1)) / 0.1, 0, 1);
      } else missing.push('indexBars');
      put('rs', ratio, {
        rule: 'technical.relativeStrength',
        value: ret3m !== null && indexRet3m !== null ? `3m ${pctStr(ret3m)} vs index ${pctStr(indexRet3m)}` : 'n/a',
        threshold: `3m return vs index >= ${pctStr(p.rsVsIndexMin)}`,
        passed: ratio === 1,
        level: ratio === 1 ? 'PASS' : 'INFO',
      });
    }

    let wsum = 0;
    let acc = 0;
    for (const c of Object.values(comps)) {
      if (c.ratio === null) continue;
      wsum += c.weight;
      acc += c.weight * c.ratio;
    }
    const score = wsum > 0 ? round((acc / wsum) * 100, 1) : null;

    // ------- verdict
    const belowSma200 = sma200 !== null && close < sma200;
    const fallingKnife =
      adx14 !== null &&
      plusDi !== null &&
      minusDi !== null &&
      sma200 !== null &&
      ret3m !== null &&
      adx14 > p.fallingKnifeAdx &&
      minusDi > plusDi &&
      belowSma200 &&
      ret3m < p.fallingKnifeRet3m;
    if (fallingKnife) {
      reasons.push(
        fail('technical.fallingKnife', `ADX ${fmt(adx14, 1)}, -DI > +DI, below SMA200, 3m ${pctStr(ret3m)}`, {
          threshold: `ADX > ${p.fallingKnifeAdx} and 3m return < ${pctStr(p.fallingKnifeRet3m, 0)} below SMA200`,
        }),
      );
    } else if (belowSma200) {
      reasons.push(
        warnRule('trend.belowSma200', `close ${fmt(close)} < SMA200 ${fmt(sma200)}`, {
          note: 'position size is halved downstream',
        }),
      );
    } else if (sma200 !== null) {
      reasons.push(pass('trend.aboveSma200', `close ${fmt(close)} >= SMA200 ${fmt(sma200)}`));
    }
    reasons.push(info('technical.support', support === null ? 'n/a' : round(support, 4), { note: supportSource }));
    if (missing.length)
      reasons.push(
        warnData('technical.partialInputs', missing.join(','), {
          note: 'weights renormalised over available components',
        }),
      );

    const verdict = fallingKnife ? 'FAIL' : reasons.some((r) => r.level === 'WARN') ? 'WARN' : 'PASS';
    return {
      skillId: this.id,
      version: this.version,
      score,
      verdict,
      reasons,
      payload: {
        close,
        support,
        supportSource,
        atr14,
        sma20,
        sma50,
        sma200,
        rsi14,
        macdHist: lastOf(m.hist),
        bbLower,
        adx14,
        plusDi,
        minusDi,
        donchian20: { upper: lastOf(d20.upper), lower: lastOf(d20.lower) },
        donchian55: { upper: lastOf(d55.upper), lower: lastOf(d55.lower) },
        ret3m,
        indexRet3m,
        pctFrom52wHigh: hi52 > 0 ? close / hi52 - 1 : null,
        pctFrom52wLow: lo52 > 0 ? close / lo52 - 1 : null,
        trendState,
        supportCandidates: below.map((c) => ({ source: c.source, level: c.level })),
        components: comps,
      },
      dataQuality: { tier: sma200 === null ? 'proxy' : 'real', missing },
    };
  },
};
