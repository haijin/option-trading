-- 03 — PostgreSQL schema (v1 prototype), REFERENCE ONLY.
-- As built: the code has moved on. The root README says what exists today; src/db/schema.ts wins over this file.
-- Source of truth is the Drizzle schema in src/db/schema.ts; migrations are generated from it (eng review
-- decision 2026-10-10). This file documents intent and is kept in sync by hand when the Drizzle schema changes.
-- Conventions: snake_case, UTC timestamps, prices as NUMERIC, identity ids,
-- JSONB for skill payloads (validated in the app with zod, versioned by skill_version).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- reference ----------
CREATE TYPE market AS ENUM ('US', 'HK');
CREATE TYPE option_right AS ENUM ('P', 'C');
CREATE TYPE exercise_style AS ENUM ('american', 'european');
CREATE TYPE verdict AS ENUM ('PASS', 'WARN', 'FAIL', 'NA');
CREATE TYPE data_tier AS ENUM ('real', 'proxy', 'synthetic');
CREATE TYPE position_status AS ENUM ('open', 'closed', 'rolled', 'assigned', 'expired');

CREATE TABLE instruments (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market             market NOT NULL,
  symbol             TEXT NOT NULL,                  -- canonical: 'AAPL', '0700'
  name               TEXT,
  currency           CHAR(3) NOT NULL,               -- USD / HKD
  sector             TEXT,
  industry           TEXT,
  solvency_model     TEXT NOT NULL DEFAULT 'altman' CHECK (solvency_model IN ('altman','property','financial','reit')),
  reporting_frequency TEXT NOT NULL DEFAULT 'quarterly' CHECK (reporting_frequency IN ('quarterly','semiannual')),
  benchmark_instrument_id BIGINT REFERENCES instruments(id),  -- SPY for US names, 2800.HK for HK names
  board_lot          INTEGER NOT NULL DEFAULT 100,   -- HK: contract multiplier; US: 100
  has_listed_options BOOLEAN NOT NULL DEFAULT TRUE,
  provider_symbols   JSONB NOT NULL DEFAULT '{}',    -- {"yahoo":"0700.HK","futu":"HK.00700","ibkr":{"symbol":"700","exchange":"SEHK"}}
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market, symbol)
);

CREATE TABLE watchlist (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id      BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  notes              TEXT,
  conviction         SMALLINT CHECK (conviction BETWEEN 1 AND 5), -- your own prior; small ranking weight
  max_collateral_pct NUMERIC(5,2),                                 -- per-name override
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instrument_id)
);

CREATE TABLE exchange_calendar (
  market         market NOT NULL,
  day            DATE NOT NULL,
  is_trading_day BOOLEAN NOT NULL,
  note           TEXT,
  PRIMARY KEY (market, day)
);

CREATE TABLE portfolio_settings (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- single row, seeded by migration
  base_currency   CHAR(3) NOT NULL DEFAULT 'HKD',
  equity          NUMERIC(18,2),                                   -- NULL until set via `cli settings set equity`; scan refuses to run while NULL
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO portfolio_settings (id) VALUES (1);
-- strategy_params 'default' v1 is seeded by the migration from the defaults in 04-skills-spec.md.

CREATE TABLE fx_rates (
  day      DATE NOT NULL,
  pair     CHAR(6) NOT NULL,          -- 'USDHKD'
  rate     NUMERIC(18,8) NOT NULL,
  source   TEXT NOT NULL,
  PRIMARY KEY (day, pair)
);

-- ---------- market data ----------
-- Index and vol benchmarks (SPX, VIX, HSI, VHSI) are stored as instruments too, with sector = 'INDEX'.
CREATE TABLE price_bars (
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  open          NUMERIC(18,6) NOT NULL,
  high          NUMERIC(18,6) NOT NULL,
  low           NUMERIC(18,6) NOT NULL,
  close         NUMERIC(18,6) NOT NULL,
  adj_close     NUMERIC(18,6) NOT NULL,
  volume        BIGINT NOT NULL,
  source        TEXT NOT NULL,
  PRIMARY KEY (instrument_id, day)
);

-- Point-in-time fundamentals. One row per statement period; reported_at is the filing/announcement time.
CREATE TABLE fundamental_statements (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id         BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  period_end            DATE NOT NULL,
  period_type           TEXT NOT NULL CHECK (period_type IN ('annual','quarterly','semiannual','ttm')),
  reported_at           TIMESTAMPTZ NOT NULL,       -- CRITICAL for backtests. If unknown: min(period_end + market lag, first_seen_at); see 02 §3
  reported_at_estimated BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when ingest first stored this statement (real point-in-time evidence from go-live)
  currency              CHAR(3) NOT NULL,
  -- income statement
  revenue NUMERIC(20,2), gross_profit NUMERIC(20,2), operating_income NUMERIC(20,2), ebit NUMERIC(20,2), ebitda NUMERIC(20,2),
  interest_expense NUMERIC(20,2),                    -- needed by the property/reit solvency model (interest cover); added in the build
  net_income NUMERIC(20,2), eps_diluted NUMERIC(18,6), shares_diluted NUMERIC(20,2),
  -- balance sheet
  total_assets NUMERIC(20,2), current_assets NUMERIC(20,2), current_liabilities NUMERIC(20,2), total_liabilities NUMERIC(20,2),
  long_term_debt NUMERIC(20,2), total_debt NUMERIC(20,2), cash NUMERIC(20,2), retained_earnings NUMERIC(20,2), total_equity NUMERIC(20,2),
  -- cash flow
  cfo NUMERIC(20,2), capex NUMERIC(20,2), fcf NUMERIC(20,2), dividends_paid NUMERIC(20,2), buybacks NUMERIC(20,2),
  raw    JSONB,                                      -- provider payload for audit
  source TEXT NOT NULL,
  UNIQUE (instrument_id, period_end, period_type, source)
);
CREATE INDEX ON fundamental_statements (instrument_id, reported_at);

CREATE TABLE corporate_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN ('earnings','ex_dividend','agm','rights_issue','spin_off','split','index_rebalance','other')),
  event_date    DATE NOT NULL,
  confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT NOT NULL DEFAULT 'manual',       -- 'yahoo' | 'futu' | 'hkex' | 'manual'
  known_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when we learned of it (point-in-time)
  details       JSONB,
  UNIQUE (instrument_id, event_type, event_date)
);

CREATE TABLE option_contracts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  occ_symbol    TEXT,                                 -- US OCC symbol; HK: HKATS code
  right_        option_right NOT NULL,
  strike        NUMERIC(18,6) NOT NULL,
  expiry        DATE NOT NULL,
  multiplier    INTEGER NOT NULL,                     -- 100 US; board lot HK (may differ from current board_lot historically)
  style         exercise_style NOT NULL DEFAULT 'american',
  UNIQUE (instrument_id, right_, strike, expiry)
);

-- One snapshot per contract per day (end of day). This is the unit backtests consume.
CREATE TABLE option_quotes (
  contract_id      BIGINT NOT NULL REFERENCES option_contracts(id) ON DELETE CASCADE,
  snapshot_date    DATE NOT NULL,
  snapshot_at      TIMESTAMPTZ NOT NULL,
  bid              NUMERIC(18,6),
  ask              NUMERIC(18,6),
  last             NUMERIC(18,6),
  mid              NUMERIC(18,6) GENERATED ALWAYS AS ((bid + ask) / 2) STORED,
  volume           INTEGER,
  open_interest    INTEGER,
  iv               NUMERIC(10,6),
  delta            NUMERIC(10,6),
  gamma            NUMERIC(12,8),
  theta            NUMERIC(12,8),
  vega             NUMERIC(12,8),
  underlying_price NUMERIC(18,6) NOT NULL,
  tier             data_tier NOT NULL DEFAULT 'real',
  source           TEXT NOT NULL,                     -- 'yahoo' | 'ibkr' | 'futu' | 'csv' | 'journal' | 'synthetic'
  PRIMARY KEY (contract_id, snapshot_date)
);
CREATE INDEX ON option_quotes (snapshot_date);

-- Real fill versus synthetic price on the same contract and date; feeds the per-market synthetic haircut.
CREATE TABLE pricing_calibration (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id      BIGINT NOT NULL REFERENCES option_contracts(id) ON DELETE CASCADE,
  day              DATE NOT NULL,
  real_price       NUMERIC(18,6) NOT NULL,
  synthetic_price  NUMERIC(18,6) NOT NULL,
  sigma_used       NUMERIC(10,6) NOT NULL,
  spot_used        NUMERIC(18,6) NOT NULL,            -- fill-time spot for journal rows, snapshot spot for chains
  delta_bucket     TEXT NOT NULL CHECK (delta_bucket IN ('0-10','10-20','20-30','30+')),
  real_source      TEXT NOT NULL,                     -- 'csv' (primary) | 'journal' (sanity only) | 'yahoo' | ...
  iv_rv_ratio      NUMERIC(10,6),                     -- implied vol of the real mid / realised-vol sigma used (chain rows; added in the build)
  UNIQUE (contract_id, day, real_source)
);

-- Daily per-underlying volatility summary (from chain if available, else proxy or synthetic).
CREATE TABLE iv_daily (
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  iv30          NUMERIC(10,6),
  iv60          NUMERIC(10,6),
  iv_rank       NUMERIC(6,2),
  iv_percentile NUMERIC(6,2),
  rv20          NUMERIC(10,6),                        -- Yang-Zhang realised vol
  rv60          NUMERIC(10,6),
  skew_25d      NUMERIC(10,6),
  term_ratio    NUMERIC(10,6),
  tier          data_tier NOT NULL,
  PRIMARY KEY (instrument_id, day)
);

CREATE TABLE market_regime (
  market         market NOT NULL,
  day            DATE NOT NULL,
  index_close    NUMERIC(18,6),
  index_sma200   NUMERIC(18,6),
  vol_index      NUMERIC(10,4),
  regime         TEXT NOT NULL CHECK (regime IN ('bull_calm','bull_volatile','bear_calm','panic','crash_guard')),
  deploy_cap_pct NUMERIC(5,2) NOT NULL,
  delta_cap      NUMERIC(5,3) NOT NULL,
  PRIMARY KEY (market, day)
);

-- ---------- strategy configuration ----------
CREATE TABLE strategy_params (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,                          -- 'default', 'aggressive', 'hk-conservative'
  version     INTEGER NOT NULL,
  params      JSONB NOT NULL,                         -- full param tree, namespaced per skill
  params_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  UNIQUE (name, version)
);

CREATE TABLE skill_definitions (
  skill_id      TEXT NOT NULL,
  version       TEXT NOT NULL,
  depends_on    TEXT[] NOT NULL DEFAULT '{}',
  param_schema  JSONB NOT NULL,
  description   TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);

-- ---------- pipeline runs ----------
CREATE TABLE scan_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of           DATE NOT NULL,
  params_id       BIGINT NOT NULL REFERENCES strategy_params(id),
  mode            TEXT NOT NULL CHECK (mode IN ('live','backtest')),
  backtest_run_id UUID,                               -- set when mode = 'backtest'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  stats           JSONB
);

-- Cached, replayable skill outputs. Same (instrument, as_of, skill, version, params_hash) gives the same row.
-- Invalidation: every writer of bars / fundamentals / corporate_events / fx_rates / option_quotes deletes rows
-- for that instrument with as_of >= earliest changed date (see 02 §2).
CREATE TABLE skill_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scan_run_id   UUID REFERENCES scan_runs(id) ON DELETE SET NULL,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  as_of         DATE NOT NULL,
  skill_id      TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  params_hash   TEXT NOT NULL,
  score         NUMERIC(6,2),
  verdict       verdict NOT NULL,
  reasons       JSONB NOT NULL,                       -- Reason[]
  payload       JSONB NOT NULL,
  data_tier     data_tier NOT NULL,
  missing       TEXT[] NOT NULL DEFAULT '{}',
  duration_ms   INTEGER,
  UNIQUE (instrument_id, as_of, skill_id, skill_version, params_hash)
);
CREATE INDEX ON skill_runs (as_of, skill_id);

CREATE TABLE recommendations (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scan_run_id             UUID NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  instrument_id           BIGINT NOT NULL REFERENCES instruments(id),
  as_of                   DATE NOT NULL,
  rank                    INTEGER NOT NULL,
  contract_id             BIGINT REFERENCES option_contracts(id),   -- null when synthetic
  synthetic_contract      JSONB,                                     -- {strike, expiry, multiplier} when no real chain
  underlying_price        NUMERIC(18,6) NOT NULL,
  strike                  NUMERIC(18,6) NOT NULL,
  expiry                  DATE NOT NULL,
  dte                     INTEGER NOT NULL,
  delta                   NUMERIC(10,6),
  credit_per_contract     NUMERIC(18,6) NOT NULL,
  collateral_per_contract NUMERIC(18,6) NOT NULL,     -- notional: strike x multiplier, in instrument currency
  collateral_base_ccy     NUMERIC(18,6) NOT NULL,     -- same, converted at fx_rates for sizing and caps
  margin_estimate         NUMERIC(18,6),              -- display only, never used for sizing
  roc_on_margin           NUMERIC(10,6),              -- display only
  roc                     NUMERIC(10,6) NOT NULL,
  annualized_roc          NUMERIC(10,6) NOT NULL,
  breakeven               NUMERIC(18,6) NOT NULL,
  cushion_pct             NUMERIC(10,6) NOT NULL,
  prob_itm                NUMERIC(6,4),
  prob_touch              NUMERIC(6,4),
  expected_value          NUMERIC(18,6),
  support_level           NUMERIC(18,6),
  fundamental_score       NUMERIC(6,2),
  technical_score         NUMERIC(6,2),
  vol_score               NUMERIC(6,2),
  option_score            NUMERIC(6,2),
  composite               NUMERIC(6,2) NOT NULL,
  confidence              NUMERIC(6,4),
  suggested_contracts     INTEGER,
  suggested_collateral    NUMERIC(18,2),
  reasons                 JSONB NOT NULL,            -- merged Reason[] from all skills
  narrative               TEXT,                      -- generated justification
  backtest_card           JSONB,                     -- {n, winRate, avgRoc, maxDD, tier, from, to}
  data_tier               data_tier NOT NULL,
  UNIQUE (scan_run_id, instrument_id)
);
CREATE INDEX ON recommendations (as_of, composite DESC);

-- ---------- positions (manual fills; the app never executes) ----------
CREATE TABLE positions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id     BIGINT NOT NULL REFERENCES instruments(id),
  recommendation_id BIGINT REFERENCES recommendations(id),
  contract_id       BIGINT REFERENCES option_contracts(id),
  right_            option_right NOT NULL DEFAULT 'P',
  strike            NUMERIC(18,6) NOT NULL,
  expiry            DATE NOT NULL,
  multiplier        INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,                 -- contracts sold (positive)
  open_date         DATE NOT NULL,
  open_price        NUMERIC(18,6) NOT NULL,
  open_fees         NUMERIC(18,6) NOT NULL DEFAULT 0,
  close_date        DATE,
  close_price       NUMERIC(18,6),
  close_fees        NUMERIC(18,6),
  status            position_status NOT NULL DEFAULT 'open',
  rolled_to         BIGINT REFERENCES positions(id),
  realized_pnl      NUMERIC(18,6),
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','journal_import')),
  notes             TEXT,
  spot_at_open      NUMERIC(18,6),                    -- journal 'spot' column; NULL excludes the row from calibration (added in the build)
  pnl_basis         TEXT,                             -- e.g. 'mtm_at_assignment' (added in the build)
  import_key        TEXT UNIQUE,                      -- row-content hash, makes journal re-import idempotent (added in the build)
  flags             TEXT[] NOT NULL DEFAULT '{}'      -- e.g. 'journal.priceOutlier' (added in the build)
);
CREATE INDEX ON positions (instrument_id) WHERE status = 'open';   -- live scan excludes these underlyings

CREATE TABLE position_marks (
  position_id             BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  day                     DATE NOT NULL,
  mark                    NUMERIC(18,6) NOT NULL,
  unrealized_pnl          NUMERIC(18,6) NOT NULL,
  pct_of_credit_captured  NUMERIC(8,4),
  dte                     INTEGER,
  underlying_price        NUMERIC(18,6),
  delta                   NUMERIC(10,6),
  alerts                  TEXT[] NOT NULL DEFAULT '{}', -- 'take_profit_50','dte_21','stop_2x','assignment_risk','earnings_added'
  tier                    data_tier NOT NULL,
  PRIMARY KEY (position_id, day)
);

-- ---------- backtests ----------
CREATE TABLE backtest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  params_id       BIGINT NOT NULL REFERENCES strategy_params(id),
  instrument_ids  BIGINT[] NOT NULL,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  tier_policy     TEXT NOT NULL CHECK (tier_policy IN ('real_only','real_then_synthetic','synthetic_only')),
  initial_capital NUMERIC(18,2) NOT NULL,
  fee_model       JSONB NOT NULL,                     -- {"us":{"perContract":0.65},"hk":{"perContract":15,"levy":...}}
  walk_forward    JSONB,                              -- {"trainMonths":36,"testMonths":12} or null
  status          TEXT NOT NULL DEFAULT 'queued',
  progress        NUMERIC(5,2) NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  metrics         JSONB,                              -- summary, see 05-backtest-design.md
  equity_curve    JSONB,                              -- [[date, equity, deployedPct, benchmark], ...]
  error           TEXT
);

CREATE TABLE backtest_trades (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  backtest_run_id       UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  instrument_id         BIGINT NOT NULL REFERENCES instruments(id),
  entry_date            DATE NOT NULL,
  expiry                DATE NOT NULL,
  strike                NUMERIC(18,6) NOT NULL,
  multiplier            INTEGER NOT NULL,
  entry_credit          NUMERIC(18,6) NOT NULL,
  entry_delta           NUMERIC(10,6),
  entry_iv              NUMERIC(10,6),
  entry_underlying      NUMERIC(18,6) NOT NULL,
  contracts             INTEGER NOT NULL,
  exit_date             DATE NOT NULL,
  exit_reason           TEXT NOT NULL CHECK (exit_reason IN ('take_profit','dte_exit','stop_loss','expired_otm','assigned','regime_exit','end_of_test')),
  exit_debit            NUMERIC(18,6) NOT NULL,
  exit_underlying       NUMERIC(18,6) NOT NULL,
  pnl                   NUMERIC(18,6) NOT NULL,
  roc                   NUMERIC(10,6) NOT NULL,
  annualized_roc        NUMERIC(10,6) NOT NULL,
  days_held             INTEGER NOT NULL,
  max_adverse_excursion NUMERIC(18,6),
  tier                  data_tier NOT NULL,
  scores                JSONB NOT NULL               -- {fundamental, technical, vol, option, composite} at entry, for attribution
);
CREATE INDEX ON backtest_trades (backtest_run_id, instrument_id);

CREATE TABLE job_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job          TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL,
  rows_written INTEGER,
  error        TEXT,
  meta         JSONB
);

-- ------------------------------------------------------------------------------------------------ news page
-- Display only: no skill reads these tables and nothing writes to corporate_events, research_verdicts or recommendations
-- from them (docs/designs/latest-news.md). Drizzle (src/db/schema.ts, migration 0008) is the source of truth.
CREATE TABLE news_items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  BIGINT REFERENCES instruments(id) ON DELETE CASCADE,   -- NULL = market-wide
  source         TEXT NOT NULL,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  snippet        TEXT,
  published_at   TIMESTAMPTZ NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash           TEXT NOT NULL,                  -- sha256 of the canonical url; kept indefinitely, never pruned
  ai_impact      TEXT CHECK (ai_impact IS NULL OR ai_impact IN ('supports','caution','blocks','neutral')),   -- NULL = not classified
  ai_summary     TEXT CHECK (ai_summary IS NULL OR char_length(ai_summary) <= 240),
  ai_rules       JSONB,                          -- [{ key: 'f'|'t'|'e'|'p', text }]
  ai_standing    JSONB,                          -- the standing the model was shown: kind, label, detail, strike, expiry, dte, otmPct
  ai_confidence  SMALLINT,
  ai_known_at    TIMESTAMPTZ,
  ai_model       TEXT,
  ai_cost_usd    NUMERIC(10,4),
  UNIQUE NULLS NOT DISTINCT (instrument_id, hash)
);
CREATE INDEX ON news_items (published_at);
CREATE INDEX ON news_items (instrument_id, published_at);

CREATE TABLE news_briefs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day        DATE NOT NULL,                      -- Hong Kong calendar day
  as_of      TIMESTAMPTZ NOT NULL,
  session    TEXT NOT NULL CHECK (session IN ('hk_open','us_open','manual')),
  lead       TEXT NOT NULL,
  bullets    JSONB NOT NULL,                     -- [{ tag, text }]
  for_puts   TEXT NOT NULL,
  tape       JSONB NOT NULL,                     -- numbers copied from our own tables, never from the model
  citations  JSONB NOT NULL,                     -- urls are a subset of news_items.url fetched in the 24 h before as_of
  model      TEXT,
  cost_usd   NUMERIC(10,4)
);
CREATE INDEX ON news_briefs (day, as_of);
CREATE UNIQUE INDEX news_briefs_scheduled_key ON news_briefs (day, session) WHERE session <> 'manual';

-- ------------------------------------------------------------------------------------------------ leaders page
-- Display only: no skill, scanner, backtest or DataAccess reads these tables, and nothing here writes to recommendations,
-- positions, research_verdicts or corporate_events (docs/designs/leaders-pullback.md). Drizzle (src/db/schema.ts, migration
-- 0013) is the source of truth.
CREATE TABLE universe_members (
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  index_code    TEXT NOT NULL CHECK (index_code IN ('SPX','NDX','MID','HSI','HSCEI','HSTECH','HSCI')),
  added_at      DATE NOT NULL,
  removed_at    DATE,                            -- stamped when a refresh no longer lists the name; never deleted
  PRIMARY KEY (instrument_id, index_code)
);
CREATE INDEX ON universe_members (index_code);

CREATE TABLE leaders_runs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market         market NOT NULL,
  as_of          DATE NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed')),
  screened       INTEGER NOT NULL DEFAULT 0,
  leaders        INTEGER NOT NULL DEFAULT 0,
  consolidating  INTEGER NOT NULL DEFAULT 0,
  shortlisted    INTEGER NOT NULL DEFAULT 0,
  regime         TEXT,
  posture        TEXT NOT NULL DEFAULT 'entries' CHECK (posture IN ('entries','watch_only')),
  params_hash    TEXT NOT NULL,
  skill_version  TEXT NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}',    -- regime payload, funnel split, bar coverage, notes
  brief_lead     TEXT,
  brief_model    TEXT,
  brief_cost_usd NUMERIC(10,4)
);
CREATE INDEX ON leaders_runs (market, as_of, started_at);

CREATE TABLE leaders_candidates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES leaders_runs(id) ON DELETE CASCADE,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  rank          SMALLINT,                        -- position in the market's own list; NULL = not on it
  state         TEXT NOT NULL CHECK (state IN ('setup','watch','extended','broken','excluded')),
  score         NUMERIC(5,2) NOT NULL DEFAULT 0,
  payload       JSONB NOT NULL,                  -- the full leaders.pullback payload (src/core/leaders.ts)
  brief_line    TEXT,
  fwd5          NUMERIC(9,5),                    -- close-to-close from the close of the day shown
  fwd10         NUMERIC(9,5),
  fwd20         NUMERIC(9,5),
  hit_3r        BOOLEAN,                         -- a high reached entry + 3R before any low reached the stop
  stopped       BOOLEAN,
  max_r         NUMERIC(8,3),                    -- stopped: exit R (below -1 on a gap); else best R reached
  days_to_3r    SMALLINT,
  outcome_as_of DATE,
  UNIQUE (run_id, instrument_id)
);
CREATE INDEX ON leaders_candidates (instrument_id, run_id);

CREATE TABLE leaders_mutes (
  instrument_id BIGINT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  until         DATE NOT NULL,
  reason        TEXT NOT NULL DEFAULT 'dismissed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
