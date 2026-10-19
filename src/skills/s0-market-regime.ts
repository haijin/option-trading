import { diffDays } from '../core/dates';
import type { Reason } from '../core/types';
import { sma } from '../indicators';
import { type AnalysisSkill, fail, info, type SkillResult, warnData } from './contract';
import { fmt, lastOf, pctStr } from './helpers';

export type Regime = 'bull_calm' | 'bull_volatile' | 'bear_calm' | 'panic' | 'crash_guard';

export interface RegimePayload {
  regime: Regime;
  deployCapPct: number;
  deltaCap: number;
  indexVsSma200Pct: number | null;
  volIndex: number | null;
  indexSymbol: string;
  volIndexSymbol: string | null;
  usedVolIndex: boolean;
  indexClose: number | null;
  overrideCrashGuard: boolean;
}

/** A vol index whose latest bar lags the index by more than this many calendar days is treated as missing. */
const VOL_INDEX_MAX_LAG_DAYS = 5;

export const marketRegime: AnalysisSkill<RegimePayload> = {
  id: 'market.regime',
  version: '1.0.0',
  dependsOn: [],
  paramKey: 'market.regime',
  cacheable: true,

  async run(ctx): Promise<SkillResult<RegimePayload>> {
    const p = ctx.params['market.regime'];
    const m = await ctx.data.market();
    const reasons: Reason[] = [];
    const missing: string[] = [];

    const closes = m.indexBars.map((b) => b.close);
    const sma200 = lastOf(sma(closes, 200));
    const indexClose = closes.length ? (closes[closes.length - 1] as number) : null;
    const lastIndexDay = m.indexBars[m.indexBars.length - 1]?.day ?? null;
    const lastVol = m.volIndexBars[m.volIndexBars.length - 1] ?? null;
    const volFresh =
      lastVol && lastIndexDay ? diffDays(lastIndexDay, lastVol.day) <= VOL_INDEX_MAX_LAG_DAYS : !!lastVol;
    const vol = volFresh && lastVol ? lastVol.close : null;
    const vsSma = indexClose !== null && sma200 !== null ? indexClose / sma200 - 1 : null;

    let regime: Regime;
    if (vsSma === null) {
      // Not enough index history to place the market: the conservative middle regime, flagged as a data gap.
      regime = 'bear_calm';
      missing.push('indexBars');
      reasons.push(
        warnData('regime.insufficientIndexHistory', closes.length, {
          threshold: '>= 200 bars',
          note: `${m.indexSymbol} has ${closes.length} bars; regime defaults to bear_calm`,
        }),
      );
    } else if (vol !== null) {
      if (vol > p.vixCrash) regime = 'crash_guard';
      else if (vol > p.vixVolatile || vsSma <= -p.belowSma200Panic) regime = 'panic';
      else if (vsSma > 0) regime = vol < p.vixCalm ? 'bull_calm' : 'bull_volatile';
      else regime = vol < p.bearCalmVolMax ? 'bear_calm' : 'panic';
    } else {
      // docs/04 S0: no vol index (VHSI has no free history) -> classify on index vs SMA200 only.
      regime = vsSma <= -p.belowSma200Panic ? 'panic' : vsSma > 0 ? 'bull_volatile' : 'bear_calm';
      missing.push('volIndex');
      reasons.push(
        warnData('regime.noVolIndex', true, {
          note: `no ${m.volIndexSymbol ?? 'vol index'} history: regime from ${m.indexSymbol} vs its 200d SMA only`,
        }),
      );
    }

    const cap = p.caps[regime];
    reasons.unshift(
      info('regime.class', regime, {
        note: `${m.indexSymbol} ${pctStr(vsSma)} vs SMA200${vol !== null ? `, ${m.volIndexSymbol} ${fmt(vol, 1)}` : ''}; deploy cap ${pctStr(cap.deployPct, 0)}, delta cap ${fmt(cap.deltaCap)}`,
      }),
    );
    if (regime === 'crash_guard') {
      reasons.push(
        p.overrideCrashGuard
          ? info('regime.crashGuardOverridden', true, { note: 'crash guard active, overridden by params' })
          : fail('regime.crashGuard', vol, { threshold: `vol index > ${p.vixCrash}`, note: 'new entries are off' }),
      );
    }

    const blocked = regime === 'crash_guard' && !p.overrideCrashGuard;
    return {
      skillId: this.id,
      version: this.version,
      score: null,
      // Informational (NA) except the crash guard, which blocks new entries.
      verdict: blocked ? 'FAIL' : 'NA',
      reasons,
      payload: {
        regime,
        deployCapPct: cap.deployPct,
        deltaCap: cap.deltaCap,
        indexVsSma200Pct: vsSma,
        volIndex: vol,
        indexSymbol: m.indexSymbol,
        volIndexSymbol: m.volIndexSymbol,
        usedVolIndex: vol !== null,
        indexClose,
        overrideCrashGuard: p.overrideCrashGuard,
      },
      dataQuality: { tier: vol !== null && vsSma !== null ? 'real' : 'proxy', missing },
    };
  },
};
