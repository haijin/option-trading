/**
 * Drizzle schema: the single source of truth for the database (docs/03-schema.sql is reference only).
 * Conventions: snake_case, UTC timestamps, prices as NUMERIC (pg returns strings; repos convert), identity ids,
 * JSONB for skill payloads. Dates are 'YYYY-MM-DD' strings.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { LeadersPayload } from '../core/leaders';
import type { NewsBullet, NewsCitation, NewsRule, NewsStanding, NewsTapeItem } from '../core/news';
import type { Reason } from '../core/types';
import type { JournalDocJson } from '../journal/types';

// ---------- enums ----------
export const marketEnum = pgEnum('market', ['US', 'HK']);
export const optionRightEnum = pgEnum('option_right', ['P', 'C']);
export const exerciseStyleEnum = pgEnum('exercise_style', ['american', 'european']);
export const verdictEnum = pgEnum('verdict', ['PASS', 'WARN', 'FAIL', 'NA']);
export const dataTierEnum = pgEnum('data_tier', ['real', 'proxy', 'synthetic']);
export const positionStatusEnum = pgEnum('position_status', ['open', 'closed', 'rolled', 'assigned', 'expired']);

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string, scale = 6) => numeric(name, { precision: 18, scale });
const big = (name: string) => numeric(name, { precision: 20, scale: 2 });

// ---------- reference ----------
export const instruments = pgTable(
  'instruments',
  {
    id: id(),
    market: marketEnum('market').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name'),
    currency: char('currency', { length: 3 }).notNull(),
    sector: text('sector'),
    industry: text('industry'),
    solvencyModel: text('solvency_model').notNull().default('altman'),
    reportingFrequency: text('reporting_frequency').notNull().default('quarterly'),
    benchmarkInstrumentId: bigint('benchmark_instrument_id', { mode: 'number' }).references(
      (): AnyPgColumn => instruments.id,
    ),
    boardLot: integer('board_lot').notNull().default(100),
    hasListedOptions: boolean('has_listed_options').notNull().default(true),
    providerSymbols: jsonb('provider_symbols').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('instruments_market_symbol_key').on(t.market, t.symbol),
    check('instruments_solvency_model_check', sql`${t.solvencyModel} in ('altman','property','financial','reit')`),
    check('instruments_reporting_frequency_check', sql`${t.reportingFrequency} in ('quarterly','semiannual')`),
  ],
);

export const watchlist = pgTable(
  'watchlist',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    notes: text('notes'),
    conviction: smallint('conviction'),
    maxCollateralPct: numeric('max_collateral_pct', { precision: 5, scale: 2 }),
    active: boolean('active').notNull().default(true),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [
    unique('watchlist_instrument_id_key').on(t.instrumentId),
    check('watchlist_conviction_check', sql`${t.conviction} between 1 and 5`),
  ],
);

export const exchangeCalendar = pgTable(
  'exchange_calendar',
  {
    market: marketEnum('market').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    isTradingDay: boolean('is_trading_day').notNull(),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.market, t.day] })],
);

/** Single row (id = 1), seeded by the migration. `equity` is NULL until `cli settings set equity`; scan refuses while NULL. */
export const portfolioSettings = pgTable(
  'portfolio_settings',
  {
    id: smallint('id').primaryKey().default(1),
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('HKD'),
    equity: numeric('equity', { precision: 18, scale: 2 }),
    /** Drawdown governor (trade-skills T3): day loss (base currency) that halts new puts; NULL = no limit. */
    dailyLossLimit: numeric('daily_loss_limit', { precision: 18, scale: 2 }),
    /** Consecutive losing closes that halt new puts; NULL = off. */
    consecutiveLossHalt: integer('consecutive_loss_halt'),
    /** De-gear tiers [{drawdownPct, multiplier}]; empty = size multiplier 1. */
    degearTiers: jsonb('degear_tiers').$type<{ drawdownPct: number; multiplier: number }[]>().notNull().default([]),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('portfolio_settings_single_row', sql`${t.id} = 1`)],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    day: date('day', { mode: 'string' }).notNull(),
    pair: char('pair', { length: 6 }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.pair] })],
);

// ---------- market data ----------
/** Index and vol-index benchmarks (SPY, VIX, 2800.HK, HSI, VHSI) are instruments with sector = 'INDEX'. */
export const priceBars = pgTable(
  'price_bars',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    open: money('open').notNull(),
    high: money('high').notNull(),
    low: money('low').notNull(),
    close: money('close').notNull(),
    adjClose: money('adj_close').notNull(),
    volume: bigint('volume', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.day] })],
);

/** Point-in-time fundamentals. `reportedAt` is the anchor; see docs/02 section 3 for the estimate and its clamp. */
export const fundamentalStatements = pgTable(
  'fundamental_statements',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    periodType: text('period_type').notNull(),
    reportedAt: ts('reported_at').notNull(),
    reportedAtEstimated: boolean('reported_at_estimated').notNull().default(false),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    currency: char('currency', { length: 3 }).notNull(),
    revenue: big('revenue'),
    grossProfit: big('gross_profit'),
    operatingIncome: big('operating_income'),
    ebit: big('ebit'),
    ebitda: big('ebitda'),
    interestExpense: big('interest_expense'),
    netIncome: big('net_income'),
    epsDiluted: numeric('eps_diluted', { precision: 18, scale: 6 }),
    sharesDiluted: big('shares_diluted'),
    totalAssets: big('total_assets'),
    currentAssets: big('current_assets'),
    currentLiabilities: big('current_liabilities'),
    totalLiabilities: big('total_liabilities'),
    longTermDebt: big('long_term_debt'),
    totalDebt: big('total_debt'),
    cash: big('cash'),
    retainedEarnings: big('retained_earnings'),
    totalEquity: big('total_equity'),
    cfo: big('cfo'),
    capex: big('capex'),
    fcf: big('fcf'),
    dividendsPaid: big('dividends_paid'),
    buybacks: big('buybacks'),
    raw: jsonb('raw'),
    source: text('source').notNull(),
  },
  (t) => [
    unique('fundamental_statements_key').on(t.instrumentId, t.periodEnd, t.periodType, t.source),
    index('fundamental_statements_reported_idx').on(t.instrumentId, t.reportedAt),
    check(
      'fundamental_statements_period_type_check',
      sql`${t.periodType} in ('annual','quarterly','semiannual','ttm')`,
    ),
  ],
);

export const corporateEvents = pgTable(
  'corporate_events',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    eventDate: date('event_date', { mode: 'string' }).notNull(),
    confirmed: boolean('confirmed').notNull().default(false),
    source: text('source').notNull().default('manual'),
    knownAt: ts('known_at').notNull().defaultNow(),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [
    unique('corporate_events_key').on(t.instrumentId, t.eventType, t.eventDate),
    check(
      'corporate_events_type_check',
      sql`${t.eventType} in ('earnings','ex_dividend','agm','rights_issue','spin_off','split','index_rebalance','other')`,
    ),
  ],
);

export const optionContracts = pgTable(
  'option_contracts',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    occSymbol: text('occ_symbol'),
    right: optionRightEnum('right_').notNull(),
    strike: money('strike').notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    multiplier: integer('multiplier').notNull(),
    style: exerciseStyleEnum('style').notNull().default('american'),
  },
  (t) => [unique('option_contracts_key').on(t.instrumentId, t.right, t.strike, t.expiry)],
);

/** One snapshot per contract per day (end of day). This is the unit backtests consume. */
export const optionQuotes = pgTable(
  'option_quotes',
  {
    contractId: bigint('contract_id', { mode: 'number' })
      .notNull()
      .references(() => optionContracts.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date', { mode: 'string' }).notNull(),
    snapshotAt: ts('snapshot_at').notNull(),
    bid: money('bid'),
    ask: money('ask'),
    last: money('last'),
    mid: money('mid').generatedAlwaysAs(sql`(bid + ask) / 2`),
    volume: integer('volume'),
    openInterest: integer('open_interest'),
    iv: numeric('iv', { precision: 10, scale: 6 }),
    delta: numeric('delta', { precision: 10, scale: 6 }),
    gamma: numeric('gamma', { precision: 12, scale: 8 }),
    theta: numeric('theta', { precision: 12, scale: 8 }),
    vega: numeric('vega', { precision: 12, scale: 8 }),
    underlyingPrice: money('underlying_price').notNull(),
    tier: dataTierEnum('tier').notNull().default('real'),
    /** 'yahoo' | 'ibkr' | 'futu' | 'csv' | 'journal'; a `+greeks:computed` suffix marks in-app greeks. */
    source: text('source').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contractId, t.snapshotDate] }),
    index('option_quotes_snapshot_date_idx').on(t.snapshotDate),
  ],
);

/** Real fill/chain price versus the synthetic price on the same contract and date; feeds the synthetic haircut. */
export const pricingCalibration = pgTable(
  'pricing_calibration',
  {
    id: id(),
    contractId: bigint('contract_id', { mode: 'number' })
      .notNull()
      .references(() => optionContracts.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    realPrice: money('real_price').notNull(),
    syntheticPrice: money('synthetic_price').notNull(),
    sigmaUsed: numeric('sigma_used', { precision: 10, scale: 6 }).notNull(),
    spotUsed: money('spot_used').notNull(),
    deltaBucket: text('delta_bucket').notNull(),
    realSource: text('real_source').notNull(),
    /** Implied vol of the real mid divided by the realised-vol sigma used (chain rows only); feeds the rvOnly IV/RV ratio. */
    ivRvRatio: numeric('iv_rv_ratio', { precision: 10, scale: 6 }),
  },
  (t) => [
    unique('pricing_calibration_key').on(t.contractId, t.day, t.realSource),
    check('pricing_calibration_bucket_check', sql`${t.deltaBucket} in ('0-10','10-20','20-30','30+')`),
  ],
);

export const ivDaily = pgTable(
  'iv_daily',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    iv30: numeric('iv30', { precision: 10, scale: 6 }),
    iv60: numeric('iv60', { precision: 10, scale: 6 }),
    ivRank: numeric('iv_rank', { precision: 6, scale: 2 }),
    ivPercentile: numeric('iv_percentile', { precision: 6, scale: 2 }),
    rv20: numeric('rv20', { precision: 10, scale: 6 }),
    rv60: numeric('rv60', { precision: 10, scale: 6 }),
    skew25d: numeric('skew_25d', { precision: 10, scale: 6 }),
    termRatio: numeric('term_ratio', { precision: 10, scale: 6 }),
    tier: dataTierEnum('tier').notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.day] })],
);

export const marketRegime = pgTable(
  'market_regime',
  {
    market: marketEnum('market').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    indexClose: money('index_close'),
    indexSma200: money('index_sma200'),
    volIndex: numeric('vol_index', { precision: 10, scale: 4 }),
    regime: text('regime').notNull(),
    deployCapPct: numeric('deploy_cap_pct', { precision: 5, scale: 2 }).notNull(),
    deltaCap: numeric('delta_cap', { precision: 5, scale: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.market, t.day] }),
    check(
      'market_regime_regime_check',
      sql`${t.regime} in ('bull_calm','bull_volatile','bear_calm','panic','crash_guard')`,
    ),
  ],
);

// ---------- strategy configuration ----------
export const strategyParams = pgTable(
  'strategy_params',
  {
    id: id(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    paramsHash: text('params_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [unique('strategy_params_name_version_key').on(t.name, t.version)],
);

export const skillDefinitions = pgTable(
  'skill_definitions',
  {
    skillId: text('skill_id').notNull(),
    version: text('version').notNull(),
    dependsOn: text('depends_on').array().notNull().default(sql`'{}'`),
    paramSchema: jsonb('param_schema').notNull(),
    description: text('description'),
    registeredAt: ts('registered_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.version] })],
);

// ---------- pipeline runs ----------
export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    paramsId: bigint('params_id', { mode: 'number' })
      .notNull()
      .references(() => strategyParams.id),
    mode: text('mode').notNull(),
    backtestRunId: uuid('backtest_run_id'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    status: text('status').notNull().default('running'),
    stats: jsonb('stats'),
  },
  (t) => [check('scan_runs_mode_check', sql`${t.mode} in ('live','backtest')`)],
);

/** Cached, replayable skill outputs. Invalidation is the writer's job (src/db/invalidate.ts). */
export const skillRuns = pgTable(
  'skill_runs',
  {
    id: id(),
    scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    skillId: text('skill_id').notNull(),
    skillVersion: text('skill_version').notNull(),
    paramsHash: text('params_hash').notNull(),
    score: numeric('score', { precision: 6, scale: 2 }),
    verdict: verdictEnum('verdict').notNull(),
    reasons: jsonb('reasons').$type<Reason[]>().notNull(),
    payload: jsonb('payload').notNull(),
    dataTier: dataTierEnum('data_tier').notNull(),
    missing: text('missing').array().notNull().default(sql`'{}'`),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    unique('skill_runs_key').on(t.instrumentId, t.asOf, t.skillId, t.skillVersion, t.paramsHash),
    index('skill_runs_as_of_skill_idx').on(t.asOf, t.skillId),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: id(),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    rank: integer('rank').notNull(),
    contractId: bigint('contract_id', { mode: 'number' }).references(() => optionContracts.id),
    syntheticContract: jsonb('synthetic_contract'),
    underlyingPrice: money('underlying_price').notNull(),
    strike: money('strike').notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    dte: integer('dte').notNull(),
    delta: numeric('delta', { precision: 10, scale: 6 }),
    creditPerContract: money('credit_per_contract').notNull(),
    collateralPerContract: money('collateral_per_contract').notNull(),
    collateralBaseCcy: money('collateral_base_ccy').notNull(),
    marginEstimate: money('margin_estimate'),
    rocOnMargin: numeric('roc_on_margin', { precision: 10, scale: 6 }),
    roc: numeric('roc', { precision: 10, scale: 6 }).notNull(),
    annualizedRoc: numeric('annualized_roc', { precision: 10, scale: 6 }).notNull(),
    breakeven: money('breakeven').notNull(),
    cushionPct: numeric('cushion_pct', { precision: 10, scale: 6 }).notNull(),
    probItm: numeric('prob_itm', { precision: 6, scale: 4 }),
    probTouch: numeric('prob_touch', { precision: 6, scale: 4 }),
    expectedValue: money('expected_value'),
    supportLevel: money('support_level'),
    fundamentalScore: numeric('fundamental_score', { precision: 6, scale: 2 }),
    technicalScore: numeric('technical_score', { precision: 6, scale: 2 }),
    volScore: numeric('vol_score', { precision: 6, scale: 2 }),
    optionScore: numeric('option_score', { precision: 6, scale: 2 }),
    composite: numeric('composite', { precision: 6, scale: 2 }).notNull(),
    confidence: numeric('confidence', { precision: 6, scale: 4 }),
    suggestedContracts: integer('suggested_contracts'),
    suggestedCollateral: numeric('suggested_collateral', { precision: 18, scale: 2 }),
    reasons: jsonb('reasons').$type<Reason[]>().notNull(),
    narrative: text('narrative'),
    backtestCard: jsonb('backtest_card'),
    dataTier: dataTierEnum('data_tier').notNull(),
  },
  (t) => [
    unique('recommendations_scan_instrument_key').on(t.scanRunId, t.instrumentId),
    index('recommendations_as_of_composite_idx').on(t.asOf, t.composite.desc()),
  ],
);

// ---------- positions (manual fills; the app never executes) ----------
export const positions = pgTable(
  'positions',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id),
    recommendationId: bigint('recommendation_id', { mode: 'number' }).references(() => recommendations.id),
    contractId: bigint('contract_id', { mode: 'number' }).references(() => optionContracts.id),
    right: optionRightEnum('right_').notNull().default('P'),
    strike: money('strike').notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    multiplier: integer('multiplier').notNull(),
    quantity: integer('quantity').notNull(),
    openDate: date('open_date', { mode: 'string' }).notNull(),
    openPrice: money('open_price').notNull(),
    openFees: money('open_fees').notNull().default('0'),
    closeDate: date('close_date', { mode: 'string' }),
    closePrice: money('close_price'),
    closeFees: money('close_fees'),
    status: positionStatusEnum('status').notNull().default('open'),
    rolledTo: bigint('rolled_to', { mode: 'number' }).references((): AnyPgColumn => positions.id),
    realizedPnl: money('realized_pnl'),
    source: text('source').notNull().default('manual'),
    notes: text('notes'),
    /** Underlying price at the fill (journal `spot` column); NULL excludes the row from calibration. */
    spotAtOpen: money('spot_at_open'),
    /** How realised P&L was booked, e.g. 'mtm_at_assignment'. */
    pnlBasis: text('pnl_basis'),
    /** Row-content hash so that re-importing the same journal file is idempotent. */
    importKey: text('import_key'),
    /** Data-quality flags set by import/calibration, e.g. 'journal.priceOutlier' (excluded from calibration). */
    flags: text('flags').array().notNull().default(sql`'{}'`),
  },
  (t) => [
    index('positions_open_instrument_idx').on(t.instrumentId).where(sql`${t.status} = 'open'`),
    unique('positions_import_key_key').on(t.importKey),
    check('positions_source_check', sql`${t.source} in ('manual','journal_import')`),
  ],
);

/**
 * Shares held after a put was assigned (the wheel, docs/06 Phase 3). One lot per assigned put; the effective cost of the
 * shares (strike less premium) is derived from the put itself for display; the stored basis is the booking basis.
 */
export const stockLots = pgTable(
  'stock_lots',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id),
    /** The assigned put this lot came from (null for a lot entered by hand). */
    positionId: bigint('position_id', { mode: 'number' }).references(() => positions.id),
    shares: integer('shares').notNull(),
    /** Per share: the underlying close at assignment. The put's realised P&L already booked (strike - that close), so valuing the shares from here on starts at this basis. */
    costBasis: money('cost_basis').notNull(),
    openDate: date('open_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('open'),
    closeDate: date('close_date', { mode: 'string' }),
    closePrice: money('close_price'),
    realizedPnl: money('realized_pnl'),
    notes: text('notes'),
  },
  (t) => [
    unique('stock_lots_position_key').on(t.positionId),
    index('stock_lots_open_idx').on(t.instrumentId).where(sql`${t.status} = 'open'`),
    check('stock_lots_status_check', sql`${t.status} in ('open','sold')`),
    check('stock_lots_shares_check', sql`${t.shares} > 0`),
  ],
);

export const positionMarks = pgTable(
  'position_marks',
  {
    positionId: bigint('position_id', { mode: 'number' })
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    mark: money('mark').notNull(),
    unrealizedPnl: money('unrealized_pnl').notNull(),
    pctOfCreditCaptured: numeric('pct_of_credit_captured', { precision: 8, scale: 4 }),
    dte: integer('dte'),
    underlyingPrice: money('underlying_price'),
    delta: numeric('delta', { precision: 10, scale: 6 }),
    alerts: text('alerts').array().notNull().default(sql`'{}'`),
    tier: dataTierEnum('tier').notNull(),
  },
  (t) => [primaryKey({ columns: [t.positionId, t.day] })],
);

// ---------- backtests (tables exist for S5's confidence lookup; the engine is Phase 4) ----------
export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    paramsId: bigint('params_id', { mode: 'number' })
      .notNull()
      .references(() => strategyParams.id),
    instrumentIds: bigint('instrument_ids', { mode: 'number' }).array().notNull(),
    fromDate: date('from_date', { mode: 'string' }).notNull(),
    toDate: date('to_date', { mode: 'string' }).notNull(),
    tierPolicy: text('tier_policy').notNull(),
    initialCapital: numeric('initial_capital', { precision: 18, scale: 2 }).notNull(),
    feeModel: jsonb('fee_model').notNull(),
    walkForward: jsonb('walk_forward'),
    /** The request as submitted (symbols, params override, options) so a run can be reproduced and compared. */
    request: jsonb('request'),
    status: text('status').notNull().default('queued'),
    progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    metrics: jsonb('metrics'),
    equityCurve: jsonb('equity_curve'),
    error: text('error'),
  },
  (t) => [
    check(
      'backtest_runs_tier_policy_check',
      sql`${t.tierPolicy} in ('real_only','real_then_synthetic','synthetic_only')`,
    ),
  ],
);

export const backtestTrades = pgTable(
  'backtest_trades',
  {
    id: id(),
    backtestRunId: uuid('backtest_run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    strike: money('strike').notNull(),
    multiplier: integer('multiplier').notNull(),
    entryCredit: money('entry_credit').notNull(),
    entryDelta: numeric('entry_delta', { precision: 10, scale: 6 }),
    entryIv: numeric('entry_iv', { precision: 10, scale: 6 }),
    entryUnderlying: money('entry_underlying').notNull(),
    contracts: integer('contracts').notNull(),
    exitDate: date('exit_date', { mode: 'string' }).notNull(),
    exitReason: text('exit_reason').notNull(),
    exitDebit: money('exit_debit').notNull(),
    exitUnderlying: money('exit_underlying').notNull(),
    pnl: money('pnl').notNull(),
    roc: numeric('roc', { precision: 10, scale: 6 }).notNull(),
    annualizedRoc: numeric('annualized_roc', { precision: 10, scale: 6 }).notNull(),
    daysHeld: integer('days_held').notNull(),
    maxAdverseExcursion: money('max_adverse_excursion'),
    tier: dataTierEnum('tier').notNull(),
    scores: jsonb('scores').notNull(),
  },
  (t) => [
    index('backtest_trades_run_instrument_idx').on(t.backtestRunId, t.instrumentId),
    check(
      'backtest_trades_exit_reason_check',
      sql`${t.exitReason} in ('take_profit','dte_exit','stop_loss','expired_otm','assigned','regime_exit','end_of_test')`,
    ),
  ],
);

export const jobRuns = pgTable('job_runs', {
  id: id(),
  job: text('job').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  status: text('status').notNull(),
  rowsWritten: integer('rows_written'),
  error: text('error'),
  meta: jsonb('meta'),
});

// ---------- milestone 2: valuation overrides, fair values, research runs ----------
/** Per-stock overrides of the intrinsic-value assumptions (growth, target P/E, DCF growth, required return). */
export const valuationOverrides = pgTable('valuation_overrides', {
  instrumentId: bigint('instrument_id', { mode: 'number' })
    .primaryKey()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Imported fair values (Morningstar CSV from the Invest-agent tool); the latest as_of per instrument is used. */
export const fairValues = pgTable(
  'fair_values',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    value: money('value').notNull(),
    source: text('source').notNull().default('morningstar_csv'),
    moat: text('moat'),
    uncertainty: text('uncertainty'),
    importedAt: ts('imported_at').notNull().defaultNow(),
  },
  (t) => [unique('fair_values_key').on(t.instrumentId, t.asOf, t.source)],
);

/** One row per analysis-skill run started from the app. Reports are files under reports/; `result` holds structured output. */
export const researchRuns = pgTable(
  'research_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull(),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    stepIndex: integer('step_index').notNull().default(0),
    progress: jsonb('progress').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    model: text('model'),
    error: text('error'),
    reportPath: text('report_path'),
    result: jsonb('result'),
  },
  (t) => [
    index('research_runs_instrument_idx').on(t.instrumentId, t.createdAt),
    check('research_runs_status_check', sql`${t.status} in ('queued','running','done','failed','cancelled')`),
  ],
);

// ---------- news page (docs/designs/latest-news.md): display only, no skill reads these tables ----------
/**
 * One story seen on one feed. Kept indefinitely (the page has a day navigator, calendar and search over history).
 * A story tagged to two names is two rows (unique per instrument and url hash): the impact is judged against each
 * name's own standing. `instrument_id` null is a market-wide story. The `ai_*` columns are model output stored as data and
 * rendered as text; null `ai_impact` means "not classified", never "neutral".
 */
export const newsItems = pgTable(
  'news_items',
  {
    id: id(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).references(() => instruments.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    snippet: text('snippet'),
    publishedAt: ts('published_at').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    /** SHA-256 of the canonical url (tracking parameters and fragments removed). */
    hash: text('hash').notNull(),
    aiImpact: text('ai_impact'),
    aiSummary: text('ai_summary'),
    aiRules: jsonb('ai_rules').$type<NewsRule[]>(),
    /** The standing the model was shown, so a past day renders exactly what was judged then. */
    aiStanding: jsonb('ai_standing').$type<NewsStanding>(),
    aiConfidence: smallint('ai_confidence'),
    aiKnownAt: ts('ai_known_at'),
    aiModel: text('ai_model'),
    aiCostUsd: numeric('ai_cost_usd', { precision: 10, scale: 4 }),
  },
  (t) => [
    unique('news_items_instrument_hash_key').on(t.instrumentId, t.hash).nullsNotDistinct(),
    index('news_items_published_idx').on(t.publishedAt),
    index('news_items_instrument_published_idx').on(t.instrumentId, t.publishedAt),
    check(
      'news_items_impact_check',
      sql`${t.aiImpact} is null or ${t.aiImpact} in ('supports','caution','blocks','neutral')`,
    ),
    check('news_items_summary_check', sql`${t.aiSummary} is null or char_length(${t.aiSummary}) <= 240`),
  ],
);

/** The market brief written for one session (HK open 07:30 HKT, US open 21:00 HKT, or a manual refresh). */
export const newsBriefs = pgTable(
  'news_briefs',
  {
    id: id(),
    /** The Hong Kong calendar day the brief belongs to (the calendar and the day navigator key on it). */
    day: date('day', { mode: 'string' }).notNull(),
    asOf: ts('as_of').notNull(),
    session: text('session').notNull(),
    lead: text('lead').notNull(),
    bullets: jsonb('bullets').$type<NewsBullet[]>().notNull(),
    forPuts: text('for_puts').notNull(),
    /** Numbers copied from our own tables, never from the model. */
    tape: jsonb('tape').$type<NewsTapeItem[]>().notNull(),
    /** Every url is one we fetched in the 24 hours before `as_of`; a brief citing anything else is rejected. */
    citations: jsonb('citations').$type<NewsCitation[]>().notNull(),
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  },
  (t) => [
    index('news_briefs_day_idx').on(t.day, t.asOf),
    uniqueIndex('news_briefs_scheduled_key').on(t.day, t.session).where(sql`${t.session} <> 'manual'`),
    check('news_briefs_session_check', sql`${t.session} in ('hk_open','us_open','manual')`),
  ],
);

// ---------- sign-in: accounts, sessions, email links ----------
/** A person who may open the app. Username and email are stored lower-case (the check constraint keeps them that way). */
export const appUsers = pgTable(
  'app_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    /** scrypt hash (see src/server/auth/passwords.ts); null for an account that only signs in with Google or an email link. */
    passwordHash: text('password_hash'),
    /** Google's stable account id (`sub`), set the first time that account signs in. */
    googleSub: text('google_sub'),
    emailVerifiedAt: ts('email_verified_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [
    unique('app_users_username_key').on(t.username),
    unique('app_users_email_key').on(t.email),
    unique('app_users_google_sub_key').on(t.googleSub),
    check('app_users_lowercase_check', sql`${t.username} = lower(${t.username}) and ${t.email} = lower(${t.email})`),
  ],
);

/** A browser session. Only the SHA-256 of the cookie value is stored, so a database leak cannot be replayed as a login. */
export const appSessions = pgTable(
  'app_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('app_sessions_user_idx').on(t.userId),
    check('app_sessions_method_check', sql`${t.method} in ('password','google','email_link','setup')`),
  ],
);

/** A one-time sign-in link sent by email. Only the SHA-256 of the token is stored; `used_at` makes it single-use. */
export const loginLinks = pgTable(
  'login_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('login_links_email_idx').on(t.email, t.createdAt)],
);

// ---------- daily journal (docs/designs/daily-journal.md): the user's own notes, never read by a skill, the scanner or a backtest ----------
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * One diary entry per user per day. `doc` is ProseMirror JSON in the fixed schema of src/journal (validated on every write);
 * `markdown`, `plain` and `word_count` are derived from it by the server. `revision_no` is the optimistic-concurrency token:
 * the client sends the number it loaded and every successful write bumps it. `deleted_at` is the soft delete (kept 30 days).
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    title: text('title'),
    template: text('template'),
    marketView: text('market_view').notNull().default('neutral'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    doc: jsonb('doc').$type<JournalDocJson>().notNull(),
    markdown: text('markdown').notNull().default(''),
    plain: text('plain').notNull().default(''),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('english', coalesce(title, '') || ' ' || plain)`),
    wordCount: integer('word_count').notNull().default(0),
    status: text('status').notNull().default('draft'),
    revisionNo: integer('revision_no').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    unique('journal_entries_user_date_key').on(t.userId, t.entryDate),
    index('journal_entries_search_idx').using('gin', t.search),
    index('journal_entries_user_date_idx').on(t.userId, t.entryDate.desc()),
    check(
      'journal_entries_template_check',
      sql`${t.template} is null or ${t.template} in ('morning','evening','trade','weekly','free')`,
    ),
    check('journal_entries_market_view_check', sql`${t.marketView} in ('bullish','neutral','bearish')`),
    check('journal_entries_status_check', sql`${t.status} in ('draft','closed')`),
  ],
);

/**
 * A saved state of an entry. `revision_no` counts the entry's revisions (1, 2, 3, ...); it is NOT the concurrency token.
 * The newest 'user' revision follows typing in place until it is 10 minutes old; accepted AI suggestions, applied
 * templates and restores always append a row of their own, so the state before them stays in the list.
 */
export const journalRevisions = pgTable(
  'journal_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    revisionNo: integer('revision_no').notNull(),
    doc: jsonb('doc').$type<JournalDocJson>().notNull(),
    markdown: text('markdown').notNull(),
    source: text('source').notNull(),
    /** Set when source = 'ai_accepted' (stage J3 adds the table it points at). */
    aiRunId: uuid('ai_run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('journal_revisions_entry_no_key').on(t.entryId, t.revisionNo),
    check('journal_revisions_source_check', sql`${t.source} in ('user','ai_accepted','restore','template')`),
  ],
);

/** The stock names an entry mentions, re-derived from the document on every save (never taken from the client). */
export const journalEntryInstruments = pgTable(
  'journal_entry_instruments',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.instrumentId] }),
    index('journal_entry_instruments_instrument_idx').on(t.instrumentId),
  ],
);

/**
 * An uploaded image. The file lives under the data root (`path`, relative: data/journal/<user>/<yyyy>/<id>.<ext>) and is
 * served only through the auth-gated route; originals are not kept (re-encoded, EXIF stripped). `entry_id` is the first
 * entry saved with it (null until then); whether anything still uses an image is decided from the entries' Markdown, not
 * from this column, so a figure copied into another day stays safe.
 */
export const journalAssets = pgTable(
  'journal_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('image'),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** SHA-256 of the uploaded bytes, so the same screenshot sent twice is stored once. */
    sha256: text('sha256').notNull(),
    path: text('path').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('journal_assets_user_sha_key').on(t.userId, t.sha256),
    index('journal_assets_entry_idx').on(t.entryId),
    index('journal_assets_created_idx').on(t.createdAt),
    check('journal_assets_kind_check', sql`${t.kind} = 'image'`),
  ],
);

/**
 * One AI rewrite of an entry. `input_markdown` is the prose the model was given, with images, tables, snapshots and
 * checklists replaced by placeholders; `locked` holds those blocks by placeholder id so they can be put back untouched.
 * `input_hash` is the hash of the entry's document when the run started: a suggestion is only accepted onto that exact
 * document. Nothing here changes an entry; only an explicit accept does, and that writes a revision first.
 */
export const journalAiRuns = pgTable(
  'journal_ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    instruction: text('instruction'),
    withContext: boolean('with_context').notNull().default(false),
    status: text('status').notNull(),
    inputMarkdown: text('input_markdown').notNull(),
    outputMarkdown: text('output_markdown'),
    outputDoc: jsonb('output_doc').$type<JournalDocJson>(),
    /** null until the author decides; true after "Use suggestion", false after "Keep mine". */
    accepted: boolean('accepted'),
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    locked: jsonb('locked').$type<{ id: string; kind: string; node: unknown }[]>().notNull().default(sql`'[]'::jsonb`),
    inputHash: text('input_hash').notNull(),
    progress: jsonb('progress').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('journal_ai_runs_entry_idx').on(t.entryId, t.createdAt),
    index('journal_ai_runs_user_day_idx').on(t.userId, t.createdAt),
    // One rewrite at a time per entry, enforced here as well as in the service.
    uniqueIndex('journal_ai_runs_one_active_key').on(t.entryId).where(sql`${t.status} in ('queued','running')`),
    check(
      'journal_ai_runs_mode_check',
      sql`${t.mode} in ('polish','tighten','structure','lessons','translate_zh','translate_en','custom')`,
    ),
    check('journal_ai_runs_status_check', sql`${t.status} in ('queued','running','done','failed','cancelled')`),
  ],
);

// ---------- leaders (docs/designs/leaders-pullback.md) ----------
/**
 * Where a universe name came from. A member is an ordinary `instruments` row (bars, FX, board lot and research runs all
 * key on the instrument id); the `watchlist` table keeps meaning "names the user follows". `removed_at` is stamped when a
 * refresh no longer lists the name in that index; nothing is deleted, so an old run can still be read.
 */
export const universeMembers = pgTable(
  'universe_members',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    indexCode: text('index_code').notNull(),
    addedAt: date('added_at', { mode: 'string' }).notNull(),
    removedAt: date('removed_at', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.indexCode] }),
    index('universe_members_index_idx').on(t.indexCode),
    check('universe_members_index_check', sql`${t.indexCode} in ('SPX','NDX','MID','HSI','HSCEI','HSTECH','HSCI')`),
  ],
);

/**
 * One scan of one market for one as-of date. `detail` holds what the page needs about the run beyond the counts: the
 * regime payload (index vs its 200d, vol index), the funnel split by stage, the coverage of the as-of bar and any notes.
 * The brief columns are filled by `leaders-brief` (stage L4) and stay null until then.
 */
export const leadersRuns = pgTable(
  'leaders_runs',
  {
    id: id(),
    market: marketEnum('market').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    status: text('status').notNull(),
    screened: integer('screened').notNull().default(0),
    leaders: integer('leaders').notNull().default(0),
    consolidating: integer('consolidating').notNull().default(0),
    shortlisted: integer('shortlisted').notNull().default(0),
    regime: text('regime'),
    posture: text('posture').notNull().default('entries'),
    paramsHash: text('params_hash').notNull(),
    skillVersion: text('skill_version').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    briefLead: text('brief_lead'),
    briefModel: text('brief_model'),
    briefCostUsd: numeric('brief_cost_usd', { precision: 10, scale: 4 }),
  },
  (t) => [
    index('leaders_runs_market_day_idx').on(t.market, t.asOf, t.startedAt),
    check('leaders_runs_status_check', sql`${t.status} in ('running','ok','partial','failed')`),
    check('leaders_runs_posture_check', sql`${t.posture} in ('entries','watch_only')`),
  ],
);

/**
 * One name on one run: every name that reached the leader test or better, plus any name that was on the previous list
 * and fell out (so the dropped row has a reason). `rank` is the position in the market's own list (null = not in it).
 * `payload` is the full skill payload; the outcome columns are stamped later from bars that arrive after the run and
 * are counted from the close of the day the Setup was shown (not a backtest).
 */
export const leadersCandidates = pgTable(
  'leaders_candidates',
  {
    id: id(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => leadersRuns.id, { onDelete: 'cascade' }),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    rank: smallint('rank'),
    state: text('state').notNull(),
    score: numeric('score', { precision: 5, scale: 2 }).notNull().default('0'),
    payload: jsonb('payload').$type<LeadersPayload>().notNull(),
    briefLine: text('brief_line'),
    fwd5: numeric('fwd5', { precision: 9, scale: 5 }),
    fwd10: numeric('fwd10', { precision: 9, scale: 5 }),
    fwd20: numeric('fwd20', { precision: 9, scale: 5 }),
    hit3r: boolean('hit_3r'),
    stopped: boolean('stopped'),
    maxR: numeric('max_r', { precision: 8, scale: 3 }),
    daysTo3r: smallint('days_to_3r'),
    outcomeAsOf: date('outcome_as_of', { mode: 'string' }),
  },
  (t) => [
    unique('leaders_candidates_run_instrument_key').on(t.runId, t.instrumentId),
    index('leaders_candidates_instrument_idx').on(t.instrumentId, t.runId),
    check('leaders_candidates_state_check', sql`${t.state} in ('setup','watch','extended','broken','excluded')`),
  ],
);

/** "Dismiss": the scan skips the name until `until`. One row per name; a second dismissal replaces the first. */
export const leadersMutes = pgTable('leaders_mutes', {
  instrumentId: bigint('instrument_id', { mode: 'number' })
    .primaryKey()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  until: date('until', { mode: 'string' }).notNull(),
  reason: text('reason').notNull().default('dismissed'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
