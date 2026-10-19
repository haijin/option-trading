/**
 * `journal calibrate` (T13, docs/01 G2, docs/05 section 1): price every pasted-chain row and every journal fill that
 * carries a spot with the SAME synthetic pricer S4 uses, and store real/synthetic per market and delta bucket.
 *
 *  - Pasted CSV chain rows are the PRIMARY set: unbiased (the whole screen, not the strikes you chose to trade). Real
 *    price = the bid (the fill a put seller gets, matching fillAssumption 'bid').
 *  - Journal fills are a selection-biased sample (you sold when premium looked rich): a sanity figure only. A fill
 *    without `spot` is excluded (a 1-2% intraday move shifts an OTM put price by 10-30%); a fill priced outside 0.5-2x the
 *    model is flagged `journal.priceOutlier` and excluded too (still counted in P&L and attribution).
 *  - Synthetic price: sigma0 = RV60 (Yang-Zhang, as of the sample date) x the default IV/RV ratio, plus the skew bump.
 *    Sigma never uses the real price, so the ratio measures the pricer, not itself.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import { deltaBucket } from '../core/contracts';
import { diffDays, type ISODate } from '../core/dates';
import type { StrategyParams } from '../core/params';
import { median } from '../core/util';
import { bsGreeks, bsPrice, impliedVol, yangZhangVol } from '../indicators';
import type { Db } from './client';
import { loadBars } from './history';
import { instruments, optionContracts, optionQuotes, positions, pricingCalibration } from './schema';
import { ensureOptionContracts, writeCalibration } from './writers';

export interface CalibrationBucketRow {
  market: Market;
  bucket: string;
  chainN: number;
  chainMedian: number | null;
  journalN: number;
  journalMedian: number | null;
}

export interface CalibrationReport {
  rows: CalibrationBucketRow[];
  /** Chain samples per market; < minSamples means "uncalibrated". */
  chainSamples: Record<Market, number>;
  calibrated: Record<Market, boolean>;
  minSamples: number;
  excluded: { journalNoSpot: number; journalOutlier: number; noVolHistory: number; illiquidChainRows: number };
  written: number;
}

const BUCKETS = ['0-10', '10-20', '20-30', '30+'] as const;

interface Sample {
  instrumentId: number;
  contractId: number;
  day: ISODate;
  real: number;
  syn: number;
  sigma: number;
  spot: number;
  bucket: (typeof BUCKETS)[number];
  source: string;
  ivRv: number | null;
}

/** Synthetic put price for (spot, strike, dte) with the S4 pricer: sigma0 plus skew bump, no haircut. */
export function syntheticModel(
  p: StrategyParams,
  market: Market,
  spot: number,
  strike: number,
  dte: number,
  sigma0: number,
): { price: number; delta: number; sigma: number } {
  const rf = market === 'HK' ? p['option.select'].riskFreeHK : p['option.select'].riskFreeUS;
  const t = dte / 365;
  const d0 = Math.abs(bsGreeks('P', spot, strike, t, rf, sigma0).delta);
  const sigmaK = sigma0 + (p['option.select'].skewBumpPer10Delta * Math.max(0, 0.5 - d0)) / 0.1;
  return {
    price: bsPrice('P', spot, strike, t, rf, sigmaK),
    delta: Math.abs(bsGreeks('P', spot, strike, t, rf, sigmaK).delta),
    sigma: sigmaK,
  };
}

export async function runCalibration(db: Db, params: StrategyParams, minSamples: number): Promise<CalibrationReport> {
  const excluded = { journalNoSpot: 0, journalOutlier: 0, noVolHistory: 0, illiquidChainRows: 0 };
  const samples: Sample[] = [];
  const barsCache = new Map<number, Awaited<ReturnType<typeof loadBars>>>();
  const yzCache = new Map<number, (number | null)[]>();
  const rvAt = async (instrumentId: number, day: ISODate): Promise<number | null> => {
    if (!barsCache.has(instrumentId)) {
      const b = await loadBars(db, instrumentId);
      barsCache.set(instrumentId, b);
      yzCache.set(instrumentId, yangZhangVol(b, 60));
    }
    const bars = barsCache.get(instrumentId) as Awaited<ReturnType<typeof loadBars>>;
    const yz = yzCache.get(instrumentId) as (number | null)[];
    let idx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if ((bars[i]?.day as string) <= day) {
        idx = i;
        break;
      }
    }
    return idx >= 0 ? (yz[idx] ?? null) : null;
  };
  const ratioDefault = (m: Market) => params['volatility.edge'].ivRvRatioDefault[m];

  // ---------------------------------------------------- pasted chains (primary)
  const chainRows = await db
    .select({ q: optionQuotes, c: optionContracts, m: instruments.market })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionContracts.id, optionQuotes.contractId))
    .innerJoin(instruments, eq(instruments.id, optionContracts.instrumentId))
    .where(and(eq(optionQuotes.source, 'csv'), eq(optionContracts.right, 'P')))
    .orderBy(asc(optionQuotes.snapshotDate));
  for (const { q, c, m } of chainRows) {
    const bid = q.bid === null ? null : Number(q.bid);
    const ask = q.ask === null ? null : Number(q.ask);
    if (bid === null || ask === null || bid <= 0 || ask < bid) {
      excluded.illiquidChainRows++;
      continue;
    }
    const dte = diffDays(c.expiry, q.snapshotDate);
    if (dte < 1) continue;
    const rv60 = await rvAt(c.instrumentId, q.snapshotDate);
    if (rv60 === null || rv60 <= 0) {
      excluded.noVolHistory++;
      continue;
    }
    const sigma0 = rv60 * ratioDefault(m);
    const spot = Number(q.underlyingPrice);
    const model = syntheticModel(params, m, spot, Number(c.strike), dte, sigma0);
    if (model.price <= 0) continue;
    const rf = m === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS;
    const impl = impliedVol('P', (bid + ask) / 2, spot, Number(c.strike), dte / 365, rf);
    samples.push({
      instrumentId: c.instrumentId,
      contractId: c.id,
      day: q.snapshotDate,
      real: bid,
      syn: model.price,
      sigma: sigma0,
      spot,
      bucket: deltaBucket(model.delta),
      source: 'csv',
      ivRv: impl !== null ? impl / rv60 : null,
    });
  }

  // ---------------------------------------------------- journal fills (sanity)
  const fills = await db
    .select({ p: positions, m: instruments.market })
    .from(positions)
    .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
    .where(eq(positions.source, 'journal_import'));
  for (const { p, m } of fills) {
    if (p.spotAtOpen === null) {
      excluded.journalNoSpot++;
      continue;
    }
    const dte = diffDays(p.expiry, p.openDate);
    if (dte < 1) continue;
    const rv60 = await rvAt(p.instrumentId, p.openDate);
    if (rv60 === null || rv60 <= 0) {
      excluded.noVolHistory++;
      continue;
    }
    const spot = Number(p.spotAtOpen);
    const model = syntheticModel(params, m, spot, Number(p.strike), dte, rv60 * ratioDefault(m));
    const real = Number(p.openPrice);
    const ratio = model.price > 0 ? real / model.price : Number.NaN;
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2) {
      excluded.journalOutlier++;
      if (!p.flags.includes('journal.priceOutlier')) {
        await db
          .update(positions)
          .set({ flags: [...p.flags, 'journal.priceOutlier'] })
          .where(eq(positions.id, p.id));
      }
      continue;
    }
    const ids = await ensureOptionContracts(db, p.instrumentId, [
      { strike: Number(p.strike), expiry: p.expiry, multiplier: p.multiplier },
    ]);
    const contractId = ids.get(`P|${Number(p.strike)}|${p.expiry}`) as number;
    if (p.contractId === null) await db.update(positions).set({ contractId }).where(eq(positions.id, p.id));
    samples.push({
      instrumentId: p.instrumentId,
      contractId,
      day: p.openDate,
      real,
      syn: model.price,
      sigma: rv60 * ratioDefault(m),
      spot,
      bucket: deltaBucket(model.delta),
      source: 'journal',
      ivRv: null,
    });
  }

  // ---------------------------------------------------- persist
  let written = 0;
  const byInstrument = new Map<number, Sample[]>();
  for (const s of samples)
    (byInstrument.get(s.instrumentId) ?? byInstrument.set(s.instrumentId, []).get(s.instrumentId))?.push(s);
  for (const [instrumentId, rows] of byInstrument) {
    const r = await writeCalibration(
      db,
      instrumentId,
      rows.map((s) => ({
        contractId: s.contractId,
        day: s.day,
        realPrice: s.real,
        syntheticPrice: s.syn,
        sigmaUsed: s.sigma,
        spotUsed: s.spot,
        deltaBucket: s.bucket,
        realSource: s.source,
        ivRvRatio: s.ivRv,
      })),
    );
    written += r.inserted;
  }

  return summarise(db, minSamples, excluded, written);
}

/** Summary over everything stored in pricing_calibration (not just this run's samples). */
export async function summarise(
  db: Db,
  minSamples: number,
  excluded: CalibrationReport['excluded'] = {
    journalNoSpot: 0,
    journalOutlier: 0,
    noVolHistory: 0,
    illiquidChainRows: 0,
  },
  written = 0,
): Promise<CalibrationReport> {
  const rows = await db
    .select({ p: pricingCalibration, m: instruments.market })
    .from(pricingCalibration)
    .innerJoin(optionContracts, eq(optionContracts.id, pricingCalibration.contractId))
    .innerJoin(instruments, eq(instruments.id, optionContracts.instrumentId));
  const out: CalibrationBucketRow[] = [];
  const chainSamples: Record<Market, number> = { US: 0, HK: 0 };
  for (const market of ['US', 'HK'] as Market[]) {
    const mine = rows.filter((r) => r.m === market);
    chainSamples[market] = mine.filter((r) => r.p.realSource !== 'journal').length;
    for (const bucket of BUCKETS) {
      const chain = mine
        .filter((r) => r.p.deltaBucket === bucket && r.p.realSource !== 'journal')
        .map((r) => Number(r.p.realPrice) / Number(r.p.syntheticPrice));
      const jr = mine
        .filter((r) => r.p.deltaBucket === bucket && r.p.realSource === 'journal')
        .map((r) => Number(r.p.realPrice) / Number(r.p.syntheticPrice));
      if (chain.length === 0 && jr.length === 0) continue;
      out.push({
        market,
        bucket,
        chainN: chain.length,
        chainMedian: median(chain),
        journalN: jr.length,
        journalMedian: median(jr),
      });
    }
  }
  return {
    rows: out,
    chainSamples,
    calibrated: { US: chainSamples.US >= minSamples, HK: chainSamples.HK >= minSamples },
    minSamples,
    excluded,
    written,
  };
}
