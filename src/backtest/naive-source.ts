/**
 * The naive benchmark of docs/05 section 2: "always sell a 30-delta, 45-DTE put on every name", no fundamental,
 * technical or regime filter. Its result minus the pipeline's result measures what the filters add. Pure: prices come
 * from the synthetic pricer on realised vol, exactly like the engine's marks, so the comparison is like for like.
 */
import type { Market } from '../core/calendar';
import { diffDays } from '../core/dates';
import { realizedVol } from '../indicators/volatility';
import { targetExpiries } from '../skills/s4-option-select';
import type { EntryCandidate, EntrySource, Underlying } from './engine';
import { entryCredit, type Haircuts, strikeForDelta, syntheticPut } from './pricer';

export interface NaiveOptions {
  deltaTarget: number;
  dteTarget: number;
  ivRvRatio: Record<Market, number>;
  skewBumpPer10Delta: number;
  riskFree: Record<Market, number>;
  haircuts: Record<Market, Haircuts>;
  /** Share of equity committed to one name (full notional). */
  maxPerNamePct: number;
}

export const NAIVE_DEFAULTS: NaiveOptions = {
  deltaTarget: 0.3,
  dteTarget: 45,
  ivRvRatio: { US: 1.15, HK: 1.1 },
  skewBumpPer10Delta: 0.02,
  riskFree: { US: 0.04, HK: 0.035 },
  haircuts: { US: { slippage: 0.1, modelRisk: 0.05 }, HK: { slippage: 0.15, modelRisk: 0.05 } },
  maxPerNamePct: 0.05,
};

function tickFor(spot: number): number {
  return spot < 25 ? 0.5 : spot < 200 ? 1 : 5;
}

export function createNaiveSource(
  underlyings: readonly Underlying[],
  opts: NaiveOptions = NAIVE_DEFAULTS,
): EntrySource {
  const rv = new Map(
    underlyings.map((u) => [
      u.instrumentId,
      realizedVol(
        u.bars.map((b) => b.adjClose),
        30,
      ),
    ]),
  );
  const pos = new Map(underlyings.map((u) => [u.instrumentId, new Map(u.bars.map((b, i) => [b.day, i]))]));
  return {
    async candidates(day, view) {
      const out: EntryCandidate[] = [];
      for (const u of underlyings) {
        const i = pos.get(u.instrumentId)?.get(day);
        if (i === undefined) continue;
        const vol = rv.get(u.instrumentId)?.[i] ?? null;
        if (vol === null || vol <= 0) continue;
        const dteMin = u.market === 'HK' ? 20 : opts.dteTarget - 10;
        const expiries = targetExpiries(u.market, day, dteMin, opts.dteTarget + 5);
        if (expiries.length === 0) continue;
        const expiry = expiries.reduce((best, e) =>
          Math.abs(diffDays(e, day) - opts.dteTarget) < Math.abs(diffDays(best, day) - opts.dteTarget) ? e : best,
        );
        const dte = diffDays(expiry, day);
        const spot = (u.bars[i] as { close: number }).close;
        const sigmaAtm = vol * opts.ivRvRatio[u.market];
        const rate = opts.riskFree[u.market];
        const strike = strikeForDelta(
          spot,
          dte,
          rate,
          sigmaAtm,
          opts.deltaTarget,
          opts.skewBumpPer10Delta,
          tickFor(spot),
          u.divYield,
        );
        const p = syntheticPut({ spot, strike, dte, rate, q: u.divYield }, sigmaAtm, opts.skewBumpPer10Delta);
        const credit = entryCredit(p.mid, opts.haircuts[u.market]);
        const fx = view.fxToBase(u.currency);
        const contracts = Math.floor((opts.maxPerNamePct * view.equity) / (strike * u.multiplier * fx));
        if (!(credit > 0) || contracts <= 0) continue;
        out.push({
          instrumentId: u.instrumentId,
          strike,
          expiry,
          fillPrice: credit,
          delta: p.delta,
          iv: p.sigma,
          contracts,
          score: (credit / strike) * (365 / dte),
          tier: 'synthetic',
        });
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };
}
