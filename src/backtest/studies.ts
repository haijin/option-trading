/**
 * Signal-level "backfill" tests for one stock (docs/05 section 5), on stored bars: what each entry rule has historically
 * been followed by, with sample counts. Fast and portfolio-free; the numbers behind a sentence like "the RSI 30-45
 * pullback rule improves put-sale win rate by X points on this name".
 */
import type { Market } from '../core/calendar';
import type { Db } from '../db/client';
import { loadBars } from '../db/history';
import { realizedVol } from '../indicators/volatility';
import { builtInRules, runEventStudy, type StudyBar } from './event-study';
import type { EventStudyView } from './views';

export async function studiesFor(
  db: Db,
  instrument: { id: number; market: Market; symbol: string },
  opts: { riskFree: number; ivRvRatio: number; horizons?: number[] },
): Promise<EventStudyView> {
  const bars = await loadBars(db, instrument.id);
  const study: StudyBar[] = bars.map((b) => ({ day: b.day, close: b.close, adjClose: b.adjClose, low: b.low }));
  const rv = realizedVol(
    bars.map((b) => b.adjClose),
    30,
  );
  const rules = builtInRules(bars.map((b) => ({ close: b.close, high: b.high, low: b.low, volume: b.volume })));
  const results = rules.map((rule) =>
    runEventStudy(study, rule, {
      horizons: opts.horizons ?? [30, 45],
      sigma: (i) => {
        const v = rv[i];
        return v === null || v === undefined ? null : v * opts.ivRvRatio;
      },
      rate: opts.riskFree,
    }),
  );
  return {
    market: instrument.market,
    symbol: instrument.symbol,
    bars: bars.length,
    from: bars[0]?.day ?? null,
    to: bars[bars.length - 1]?.day ?? null,
    rules: results as EventStudyView['rules'],
  };
}
