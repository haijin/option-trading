import { z } from 'zod';
import { hashParams } from './util';

/**
 * Strategy parameters: one namespaced tree, one schema per skill (docs/04-skills-spec.md holds the defaults).
 * The tree is persisted in `strategy_params`; every skill result is cached under the hash of the params it depends on.
 */

const perMarket = <T extends z.ZodType>(schema: T, us: z.input<T>, hk: z.input<T>) =>
  z.object({ US: schema.default(us as never), HK: schema.default(hk as never) }).prefault({ US: us, HK: hk });

export const marketRegimeParams = z.object({
  vixCalm: z.number().default(20),
  vixVolatile: z.number().default(30),
  vixCrash: z.number().default(40),
  belowSma200Panic: z.number().default(0.1),
  overrideCrashGuard: z.boolean().default(false),
  /** Below the 200d SMA, a vol index under this level is "bear calm"; at or above it the regime is "panic". */
  bearCalmVolMax: z.number().default(25),
  caps: z
    .object({
      bull_calm: z.object({ deployPct: z.number(), deltaCap: z.number() }).default({ deployPct: 0.5, deltaCap: 0.3 }),
      bull_volatile: z
        .object({ deployPct: z.number(), deltaCap: z.number() })
        .default({ deployPct: 0.5, deltaCap: 0.25 }),
      bear_calm: z.object({ deployPct: z.number(), deltaCap: z.number() }).default({ deployPct: 0.3, deltaCap: 0.2 }),
      panic: z.object({ deployPct: z.number(), deltaCap: z.number() }).default({ deployPct: 0.25, deltaCap: 0.15 }),
      crash_guard: z.object({ deployPct: z.number(), deltaCap: z.number() }).default({ deployPct: 0, deltaCap: 0 }),
    })
    .prefault({}),
});

export const fundamentalGateParams = z.object({
  fScoreMin: z.number().default(6),
  fScoreWarn: z.number().default(4),
  zPass: z.number().default(2.99),
  zWarn: z.number().default(1.81),
  roicMin: z.number().default(0.1),
  fcfYieldMin: z.number().default(0.04),
  netDebtEbitdaMax: z.number().default(3),
  gmStdevMaxPts: z.number().default(5),
  revCagr3yMin: z.number().default(0),
  epsPositiveYearsMin: z.number().default(3),
  allowEarningsInWindow: z.boolean().default(false),
  earningsIvrOverride: z.number().default(60),
  valuationZMax: z.number().default(1.5),
  valuationZExcellent: z.number().default(-1),
  weights: z
    .object({ quality: z.number().default(0.4), strength: z.number().default(0.3), valuation: z.number().default(0.3) })
    .prefault({}),
  /** Property / REIT solvency thresholds (docs/01 A2). */
  gearingPass: z.number().default(0.6),
  gearingWarn: z.number().default(1.0),
  reitGearingPass: z.number().default(0.45),
  reitGearingWarn: z.number().default(0.5),
  interestCoverPass: z.number().default(3),
  interestCoverWarn: z.number().default(1.5),
  /** "Excellent" anchors for the 0-100 sub-score interpolation (threshold -> 0, excellent -> 100). */
  roicExcellent: z.number().default(0.25),
  fcfYieldExcellent: z.number().default(0.08),
  netDebtEbitdaExcellent: z.number().default(1),
  gmStdevExcellent: z.number().default(1.5),
  revCagrExcellent: z.number().default(0.1),
  fScoreExcellent: z.number().default(8),
  zExcellent: z.number().default(4),
  gearingExcellent: z.number().default(0.2),
  interestCoverExcellent: z.number().default(8),
  /** More than this share of tests skipped for missing data makes the verdict WARN (fundamentals.insufficientData). */
  maxSkippedFraction: z.number().default(0.5),
  /** NOPAT = EBIT x (1 - rate): statements carry no tax line, so ROIC uses an assumed rate. */
  roicTaxRate: z.number().default(0.25),
  /** A dividend counts as cut when paid < previous year x this factor. */
  dividendCutFactor: z.number().default(0.95),
  /** Years of history needed for the 5-year medians and z-scores (docs/01 A3/A4). */
  historyYears: z.number().default(5),
});

export const technicalTimingParams = z.object({
  rsiLo: z.number().default(30),
  rsiHi: z.number().default(45),
  bbTouchDays: z.number().default(5),
  supportAtrMin: z.number().default(1.0),
  sma50SlopeDays: z.number().default(20),
  volSpikeMult: z.number().default(1.5),
  rsVsIndexMin: z.number().default(-0.05),
  weights: z
    .object({
      trend: z.number().default(25),
      pullback: z.number().default(20),
      support: z.number().default(20),
      momentum: z.number().default(15),
      volume: z.number().default(10),
      rs: z.number().default(10),
    })
    .prefault({}),
  fallingKnifeAdx: z.number().default(30),
  fallingKnifeRet3m: z.number().default(-0.2),
  syntheticSupportAtr: z.number().default(2),
});

export const volatilityEdgeParams = z.object({
  ivrMin: z.number().default(30),
  ivrGood: z.number().default(50),
  ivrGreat: z.number().default(70),
  vrpMinRatio: z.number().default(1.0),
  vrpGoodRatio: z.number().default(1.2),
  /**
   * Forward-aligned variance risk premium (docs/designs/trade-skills-integration.md, T1): IV30 at day t against the
   * realised vol of the next `vrpWindowDays` trading days, over the last `vrpObservations` non-overlapping windows.
   * Implied above realised in >= vrpPositiveMin windows is a positive premium; below in >= vrpNegativeMin is a
   * structurally negative one.
   */
  vrpWindowDays: z.number().default(30),
  vrpObservations: z.number().default(10),
  vrpPositiveMin: z.number().default(6),
  vrpNegativeMin: z.number().default(6),
  termBackwardationMax: z.number().default(1.05),
  proxyBeta: z.boolean().default(true),
  /** IV/RV ratio used when only realised vol exists (docs/05 §1 defaults). */
  ivRvRatioDefault: perMarket(z.number(), 1.15, 1.1),
  calibrationMinSamples: z.number().default(10),
  /** Real stored IV30 points needed before IV rank is computed on real history instead of the proxy series. */
  ivHistoryMinPoints: z.number().default(60),
  backwardationPenalty: z.number().default(15),
  skewBonus: z.number().default(5),
  /**
   * IV-source reason (trade-skills T3, pitfalls 21 and 7): results within `ivSourceEventDays` and a front-heavy term
   * ratio (front / next IV >= `ivSourceFrontHeavyMin`; a flat surface at 1.0 is not front-heavy) is event IV that
   * crushes on the date; no result within `ivSourceDemandDays` and an IV rank above `ivrMin` is demand IV that may
   * persist (a WARN on a short put).
   */
  ivSourceEventDays: z.number().default(14),
  ivSourceFrontHeavyMin: z.number().default(1.02),
  ivSourceDemandDays: z.number().default(45),
  /**
   * IV-floor rule (pitfall 37): an IV percentile at or below `ivFloorPercentileMax` with a result between
   * `ivFloorRampMinDays` and `ivFloorRampMaxDays` out means the premium is about to ramp into it: WARN `vol.ivFloorRamp`,
   * which the scan treats as a gate (Wait).
   */
  ivFloorPercentileMax: z.number().default(10),
  ivFloorRampMinDays: z.number().default(30),
  ivFloorRampMaxDays: z.number().default(60),
});

export const optionSelectParams = z.object({
  dteMin: perMarket(z.number(), 30, 20),
  dteMax: z.preprocess((v) => (typeof v === 'number' ? { US: v, HK: 180 } : v), perMarket(z.number(), 45, 180)),
  deltaMin: z.number().default(0.15),
  deltaMax: z.number().default(0.3),
  strikeBelowSupport: z.boolean().default(true),
  minAnnRoc: perMarket(z.number(), 0.12, 0.1),
  maxSpreadPct: perMarket(z.number(), 0.1, 0.15),
  minOI: perMarket(z.number(), 100, 50),
  fillAssumption: z.enum(['bid', 'mid_minus_tick']).default('bid'),
  riskFreeUS: z.number().default(0.04),
  riskFreeHK: z.number().default(0.035),
  relaxSupport: z.boolean().default(false),
  allowSynthetic: z.boolean().default(true),
  hkMarginPctOfNotional: z.number().default(0.25),
  /** Synthetic pricing (docs/05 §1). */
  skewBumpPer10Delta: z.number().default(0.02),
  slippageHaircut: perMarket(z.number(), 0.1, 0.15),
  modelRiskHaircut: z.number().default(0.05),
  syntheticStrikeSteps: z.number().int().min(1).max(100).default(12),
});

export const rankCompositeParams = z.object({
  weights: z
    .object({
      fundamental: z.number().default(0.35),
      technical: z.number().default(0.25),
      vol: z.number().default(0.2),
      option: z.number().default(0.2),
    })
    .prefault({}),
  targetAnnRoc: z.number().default(0.15),
  convictionWeight: z.number().default(0.05),
  priorN: z.number().default(30),
  warnMultiplier: z.number().default(0.85),
});

export const sizePositionParams = z.object({
  maxPerNamePct: z.number().default(0.05),
  maxSectorOpen: z.number().default(3),
  kellyFraction: z.number().default(0.25),
  earningsHalfSize: z.number().default(0.5),
  belowSma200Factor: z.number().default(0.5),
});

/**
 * The Leaders page's pullback-buy screen (docs/designs/leaders-pullback.md). Distances and ratios are fractions; the rank
 * percentiles are 0-100; dollar volume is the 20-day median of close x volume in the name's own currency.
 */
export const leadersPullbackParams = z.object({
  /** Stage A: history and liquidity rows. */
  minBars: z.number().int().default(130),
  minPrice: perMarket(z.number(), 5, 2),
  minDollarVol: perMarket(z.number(), 20_000_000, 30_000_000),
  /** Leader: 3- or 6-month gain at least this, and a rank percentile of at least leaderRankPct in leaderWindowsNeeded of 3 windows. */
  leaderMinGain: z.number().default(0.3),
  leaderRankPct: z.number().default(75),
  leaderWindowsNeeded: z.number().int().min(1).max(3).default(2),
  /** Stage B: the base. The anchor is the highest high in baseLookback bars, at least baseMinLen bars ago. */
  baseLookback: z.number().int().default(60),
  baseMinLen: z.number().int().default(5),
  baseMaxLen: z.number().int().default(45),
  depthMin: z.number().default(0.04),
  depthMax: z.number().default(0.25),
  /** A 10-bar range above this share of the 20-bar range is not a base (hard cap); below contractionScore it starts to score. */
  contractionCap: z.number().default(1.1),
  contractionScore: z.number().default(0.75),
  contractionBest: z.number().default(0.5),
  volDryUpScore: z.number().default(0.9),
  volDryUpBest: z.number().default(0.6),
  atrRatioScore: z.number().default(1.0),
  atrRatioBest: z.number().default(0.8),
  /** Stage C: a level is in play when a low of the last 3 bars came within the wider of these of it. */
  supportTolerancePct: z.number().default(0.015),
  supportToleranceAtr: z.number().default(0.5),
  /** Stage D/E: the stop sits stopBufferPct under the lower of today's and yesterday's low. */
  stopBufferPct: z.number().default(0.002),
  stopTightPct: z.number().default(0.025),
  stopMaxPct: z.number().default(0.03),
  riskPctPerTrade: z.number().default(0.005),
  earningsBlackoutDays: z.number().int().default(7),
  extendedAtr: z.number().default(3),
  extendedPct: z.number().default(0.08),
  /** Stage F: the list. */
  shortlistSize: z.number().int().default(20),
  marketFloor: z.number().int().default(5),
  weights: z
    .object({
      momentum: z.number().default(25),
      tightness: z.number().default(20),
      confluence: z.number().default(20),
      trigger: z.number().default(20),
      liquidity: z.number().default(15),
    })
    .prefault({}),
  penalties: z
    .object({
      earnings: z.number().default(15),
      stopWide: z.number().default(10),
      lotTooBig: z.number().default(5),
      watchOnly: z.number().default(20),
    })
    .prefault({}),
});

export const runnerParams = z.object({
  /** A pasted CSV chain may be this many calendar days old at the freshness gate. */
  chainMaxAgeDays: z.number().default(3),
  /** Names listed in the "paste chains for these" block. */
  pasteTopN: z.number().default(5),
  topN: z.number().default(10),
  maxPerSector: z.number().default(3),
  maxPerCurrency: z.number().default(10),
});

export const paramsSchema = z.object({
  'market.regime': marketRegimeParams.prefault({}),
  'fundamental.gate': fundamentalGateParams.prefault({}),
  'technical.timing': technicalTimingParams.prefault({}),
  'volatility.edge': volatilityEdgeParams.prefault({}),
  'option.select': optionSelectParams.prefault({}),
  'rank.composite': rankCompositeParams.prefault({}),
  'size.position': sizePositionParams.prefault({}),
  'leaders.pullback': leadersPullbackParams.prefault({}),
  runner: runnerParams.prefault({}),
});

export type StrategyParams = z.output<typeof paramsSchema>;
export type SkillParamKey = Exclude<keyof StrategyParams, 'runner'>;

export type MarketRegimeParams = z.output<typeof marketRegimeParams>;
export type FundamentalGateParams = z.output<typeof fundamentalGateParams>;
export type TechnicalTimingParams = z.output<typeof technicalTimingParams>;
export type VolatilityEdgeParams = z.output<typeof volatilityEdgeParams>;
export type OptionSelectParams = z.output<typeof optionSelectParams>;
export type RankCompositeParams = z.output<typeof rankCompositeParams>;
export type SizePositionParams = z.output<typeof sizePositionParams>;
export type LeadersPullbackParams = z.output<typeof leadersPullbackParams>;
export type RunnerParams = z.output<typeof runnerParams>;

export function defaultParams(): StrategyParams {
  return paramsSchema.parse({});
}

/** Parse a stored (possibly partial or older) tree, filling any missing key with the current default. */
export function resolveParams(raw: unknown): StrategyParams {
  return paramsSchema.parse(raw ?? {});
}

export function paramsHash(params: unknown): string {
  return hashParams(params);
}
