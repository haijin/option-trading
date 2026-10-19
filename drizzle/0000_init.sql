CREATE TYPE "public"."data_tier" AS ENUM('real', 'proxy', 'synthetic');--> statement-breakpoint
CREATE TYPE "public"."exercise_style" AS ENUM('american', 'european');--> statement-breakpoint
CREATE TYPE "public"."market" AS ENUM('US', 'HK');--> statement-breakpoint
CREATE TYPE "public"."option_right" AS ENUM('P', 'C');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closed', 'rolled', 'assigned', 'expired');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('PASS', 'WARN', 'FAIL', 'NA');--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"params_id" bigint NOT NULL,
	"instrument_ids" bigint[] NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"tier_policy" text NOT NULL,
	"initial_capital" numeric(18, 2) NOT NULL,
	"fee_model" jsonb NOT NULL,
	"walk_forward" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" numeric(5, 2) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"metrics" jsonb,
	"equity_curve" jsonb,
	"error" text,
	CONSTRAINT "backtest_runs_tier_policy_check" CHECK ("backtest_runs"."tier_policy" in ('real_only','real_then_synthetic','synthetic_only'))
);
--> statement-breakpoint
CREATE TABLE "backtest_trades" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backtest_trades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"backtest_run_id" uuid NOT NULL,
	"instrument_id" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"expiry" date NOT NULL,
	"strike" numeric(18, 6) NOT NULL,
	"multiplier" integer NOT NULL,
	"entry_credit" numeric(18, 6) NOT NULL,
	"entry_delta" numeric(10, 6),
	"entry_iv" numeric(10, 6),
	"entry_underlying" numeric(18, 6) NOT NULL,
	"contracts" integer NOT NULL,
	"exit_date" date NOT NULL,
	"exit_reason" text NOT NULL,
	"exit_debit" numeric(18, 6) NOT NULL,
	"exit_underlying" numeric(18, 6) NOT NULL,
	"pnl" numeric(18, 6) NOT NULL,
	"roc" numeric(10, 6) NOT NULL,
	"annualized_roc" numeric(10, 6) NOT NULL,
	"days_held" integer NOT NULL,
	"max_adverse_excursion" numeric(18, 6),
	"tier" "data_tier" NOT NULL,
	"scores" jsonb NOT NULL,
	CONSTRAINT "backtest_trades_exit_reason_check" CHECK ("backtest_trades"."exit_reason" in ('take_profit','dte_exit','stop_loss','expired_otm','assigned','regime_exit','end_of_test'))
);
--> statement-breakpoint
CREATE TABLE "corporate_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "corporate_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"event_date" date NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"known_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb,
	CONSTRAINT "corporate_events_key" UNIQUE("instrument_id","event_type","event_date"),
	CONSTRAINT "corporate_events_type_check" CHECK ("corporate_events"."event_type" in ('earnings','ex_dividend','agm','rights_issue','spin_off','split','index_rebalance','other'))
);
--> statement-breakpoint
CREATE TABLE "exchange_calendar" (
	"market" "market" NOT NULL,
	"day" date NOT NULL,
	"is_trading_day" boolean NOT NULL,
	"note" text,
	CONSTRAINT "exchange_calendar_market_day_pk" PRIMARY KEY("market","day")
);
--> statement-breakpoint
CREATE TABLE "fundamental_statements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fundamental_statements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"period_end" date NOT NULL,
	"period_type" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"reported_at_estimated" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"currency" char(3) NOT NULL,
	"revenue" numeric(20, 2),
	"gross_profit" numeric(20, 2),
	"operating_income" numeric(20, 2),
	"ebit" numeric(20, 2),
	"ebitda" numeric(20, 2),
	"interest_expense" numeric(20, 2),
	"net_income" numeric(20, 2),
	"eps_diluted" numeric(18, 6),
	"shares_diluted" numeric(20, 2),
	"total_assets" numeric(20, 2),
	"current_assets" numeric(20, 2),
	"current_liabilities" numeric(20, 2),
	"total_liabilities" numeric(20, 2),
	"long_term_debt" numeric(20, 2),
	"total_debt" numeric(20, 2),
	"cash" numeric(20, 2),
	"retained_earnings" numeric(20, 2),
	"total_equity" numeric(20, 2),
	"cfo" numeric(20, 2),
	"capex" numeric(20, 2),
	"fcf" numeric(20, 2),
	"dividends_paid" numeric(20, 2),
	"buybacks" numeric(20, 2),
	"raw" jsonb,
	"source" text NOT NULL,
	CONSTRAINT "fundamental_statements_key" UNIQUE("instrument_id","period_end","period_type","source"),
	CONSTRAINT "fundamental_statements_period_type_check" CHECK ("fundamental_statements"."period_type" in ('annual','quarterly','semiannual','ttm'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"day" date NOT NULL,
	"pair" char(6) NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "fx_rates_day_pair_pk" PRIMARY KEY("day","pair")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instruments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"name" text,
	"currency" char(3) NOT NULL,
	"sector" text,
	"industry" text,
	"solvency_model" text DEFAULT 'altman' NOT NULL,
	"reporting_frequency" text DEFAULT 'quarterly' NOT NULL,
	"benchmark_instrument_id" bigint,
	"board_lot" integer DEFAULT 100 NOT NULL,
	"has_listed_options" boolean DEFAULT true NOT NULL,
	"provider_symbols" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_market_symbol_key" UNIQUE("market","symbol"),
	CONSTRAINT "instruments_solvency_model_check" CHECK ("instruments"."solvency_model" in ('altman','property','financial','reit')),
	CONSTRAINT "instruments_reporting_frequency_check" CHECK ("instruments"."reporting_frequency" in ('quarterly','semiannual'))
);
--> statement-breakpoint
CREATE TABLE "iv_daily" (
	"instrument_id" bigint NOT NULL,
	"day" date NOT NULL,
	"iv30" numeric(10, 6),
	"iv60" numeric(10, 6),
	"iv_rank" numeric(6, 2),
	"iv_percentile" numeric(6, 2),
	"rv20" numeric(10, 6),
	"rv60" numeric(10, 6),
	"skew_25d" numeric(10, 6),
	"term_ratio" numeric(10, 6),
	"tier" "data_tier" NOT NULL,
	CONSTRAINT "iv_daily_instrument_id_day_pk" PRIMARY KEY("instrument_id","day")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"rows_written" integer,
	"error" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "market_regime" (
	"market" "market" NOT NULL,
	"day" date NOT NULL,
	"index_close" numeric(18, 6),
	"index_sma200" numeric(18, 6),
	"vol_index" numeric(10, 4),
	"regime" text NOT NULL,
	"deploy_cap_pct" numeric(5, 2) NOT NULL,
	"delta_cap" numeric(5, 3) NOT NULL,
	CONSTRAINT "market_regime_market_day_pk" PRIMARY KEY("market","day"),
	CONSTRAINT "market_regime_regime_check" CHECK ("market_regime"."regime" in ('bull_calm','bull_volatile','bear_calm','panic','crash_guard'))
);
--> statement-breakpoint
CREATE TABLE "option_contracts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "option_contracts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"occ_symbol" text,
	"right_" "option_right" NOT NULL,
	"strike" numeric(18, 6) NOT NULL,
	"expiry" date NOT NULL,
	"multiplier" integer NOT NULL,
	"style" "exercise_style" DEFAULT 'american' NOT NULL,
	CONSTRAINT "option_contracts_key" UNIQUE("instrument_id","right_","strike","expiry")
);
--> statement-breakpoint
CREATE TABLE "option_quotes" (
	"contract_id" bigint NOT NULL,
	"snapshot_date" date NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"bid" numeric(18, 6),
	"ask" numeric(18, 6),
	"last" numeric(18, 6),
	"mid" numeric(18, 6) GENERATED ALWAYS AS ((bid + ask) / 2) STORED,
	"volume" integer,
	"open_interest" integer,
	"iv" numeric(10, 6),
	"delta" numeric(10, 6),
	"gamma" numeric(12, 8),
	"theta" numeric(12, 8),
	"vega" numeric(12, 8),
	"underlying_price" numeric(18, 6) NOT NULL,
	"tier" "data_tier" DEFAULT 'real' NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "option_quotes_contract_id_snapshot_date_pk" PRIMARY KEY("contract_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "portfolio_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_currency" char(3) DEFAULT 'HKD' NOT NULL,
	"equity" numeric(18, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_settings_single_row" CHECK ("portfolio_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "position_marks" (
	"position_id" bigint NOT NULL,
	"day" date NOT NULL,
	"mark" numeric(18, 6) NOT NULL,
	"unrealized_pnl" numeric(18, 6) NOT NULL,
	"pct_of_credit_captured" numeric(8, 4),
	"dte" integer,
	"underlying_price" numeric(18, 6),
	"delta" numeric(10, 6),
	"alerts" text[] DEFAULT '{}' NOT NULL,
	"tier" "data_tier" NOT NULL,
	CONSTRAINT "position_marks_position_id_day_pk" PRIMARY KEY("position_id","day")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "positions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"recommendation_id" bigint,
	"contract_id" bigint,
	"right_" "option_right" DEFAULT 'P' NOT NULL,
	"strike" numeric(18, 6) NOT NULL,
	"expiry" date NOT NULL,
	"multiplier" integer NOT NULL,
	"quantity" integer NOT NULL,
	"open_date" date NOT NULL,
	"open_price" numeric(18, 6) NOT NULL,
	"open_fees" numeric(18, 6) DEFAULT '0' NOT NULL,
	"close_date" date,
	"close_price" numeric(18, 6),
	"close_fees" numeric(18, 6),
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"rolled_to" bigint,
	"realized_pnl" numeric(18, 6),
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text,
	"spot_at_open" numeric(18, 6),
	"pnl_basis" text,
	"import_key" text,
	CONSTRAINT "positions_import_key_key" UNIQUE("import_key"),
	CONSTRAINT "positions_source_check" CHECK ("positions"."source" in ('manual','journal_import'))
);
--> statement-breakpoint
CREATE TABLE "price_bars" (
	"instrument_id" bigint NOT NULL,
	"day" date NOT NULL,
	"open" numeric(18, 6) NOT NULL,
	"high" numeric(18, 6) NOT NULL,
	"low" numeric(18, 6) NOT NULL,
	"close" numeric(18, 6) NOT NULL,
	"adj_close" numeric(18, 6) NOT NULL,
	"volume" bigint NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "price_bars_instrument_id_day_pk" PRIMARY KEY("instrument_id","day")
);
--> statement-breakpoint
CREATE TABLE "pricing_calibration" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pricing_calibration_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"contract_id" bigint NOT NULL,
	"day" date NOT NULL,
	"real_price" numeric(18, 6) NOT NULL,
	"synthetic_price" numeric(18, 6) NOT NULL,
	"sigma_used" numeric(10, 6) NOT NULL,
	"spot_used" numeric(18, 6) NOT NULL,
	"delta_bucket" text NOT NULL,
	"real_source" text NOT NULL,
	CONSTRAINT "pricing_calibration_key" UNIQUE("contract_id","day","real_source"),
	CONSTRAINT "pricing_calibration_bucket_check" CHECK ("pricing_calibration"."delta_bucket" in ('0-10','10-20','20-30','30+'))
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recommendations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scan_run_id" uuid NOT NULL,
	"instrument_id" bigint NOT NULL,
	"as_of" date NOT NULL,
	"rank" integer NOT NULL,
	"contract_id" bigint,
	"synthetic_contract" jsonb,
	"underlying_price" numeric(18, 6) NOT NULL,
	"strike" numeric(18, 6) NOT NULL,
	"expiry" date NOT NULL,
	"dte" integer NOT NULL,
	"delta" numeric(10, 6),
	"credit_per_contract" numeric(18, 6) NOT NULL,
	"collateral_per_contract" numeric(18, 6) NOT NULL,
	"collateral_base_ccy" numeric(18, 6) NOT NULL,
	"margin_estimate" numeric(18, 6),
	"roc_on_margin" numeric(10, 6),
	"roc" numeric(10, 6) NOT NULL,
	"annualized_roc" numeric(10, 6) NOT NULL,
	"breakeven" numeric(18, 6) NOT NULL,
	"cushion_pct" numeric(10, 6) NOT NULL,
	"prob_itm" numeric(6, 4),
	"prob_touch" numeric(6, 4),
	"expected_value" numeric(18, 6),
	"support_level" numeric(18, 6),
	"fundamental_score" numeric(6, 2),
	"technical_score" numeric(6, 2),
	"vol_score" numeric(6, 2),
	"option_score" numeric(6, 2),
	"composite" numeric(6, 2) NOT NULL,
	"confidence" numeric(6, 4),
	"suggested_contracts" integer,
	"suggested_collateral" numeric(18, 2),
	"reasons" jsonb NOT NULL,
	"narrative" text,
	"backtest_card" jsonb,
	"data_tier" "data_tier" NOT NULL,
	CONSTRAINT "recommendations_scan_instrument_key" UNIQUE("scan_run_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"as_of" date NOT NULL,
	"params_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"backtest_run_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	CONSTRAINT "scan_runs_mode_check" CHECK ("scan_runs"."mode" in ('live','backtest'))
);
--> statement-breakpoint
CREATE TABLE "skill_definitions" (
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"depends_on" text[] DEFAULT '{}' NOT NULL,
	"param_schema" jsonb NOT NULL,
	"description" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_definitions_skill_id_version_pk" PRIMARY KEY("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skill_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scan_run_id" uuid,
	"instrument_id" bigint NOT NULL,
	"as_of" date NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version" text NOT NULL,
	"params_hash" text NOT NULL,
	"score" numeric(6, 2),
	"verdict" "verdict" NOT NULL,
	"reasons" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"data_tier" "data_tier" NOT NULL,
	"missing" text[] DEFAULT '{}' NOT NULL,
	"duration_ms" integer,
	CONSTRAINT "skill_runs_key" UNIQUE("instrument_id","as_of","skill_id","skill_version","params_hash")
);
--> statement-breakpoint
CREATE TABLE "strategy_params" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "strategy_params_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "strategy_params_name_version_key" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "watchlist_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"notes" text,
	"conviction" smallint,
	"max_collateral_pct" numeric(5, 2),
	"active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_instrument_id_key" UNIQUE("instrument_id"),
	CONSTRAINT "watchlist_conviction_check" CHECK ("watchlist"."conviction" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_params_id_strategy_params_id_fk" FOREIGN KEY ("params_id") REFERENCES "public"."strategy_params"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_events" ADD CONSTRAINT "corporate_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamental_statements" ADD CONSTRAINT "fundamental_statements_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_benchmark_instrument_id_instruments_id_fk" FOREIGN KEY ("benchmark_instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iv_daily" ADD CONSTRAINT "iv_daily_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_quotes" ADD CONSTRAINT "option_quotes_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_rolled_to_positions_id_fk" FOREIGN KEY ("rolled_to") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_bars" ADD CONSTRAINT "price_bars_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_calibration" ADD CONSTRAINT "pricing_calibration_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_params_id_strategy_params_id_fk" FOREIGN KEY ("params_id") REFERENCES "public"."strategy_params"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_trades_run_instrument_idx" ON "backtest_trades" USING btree ("backtest_run_id","instrument_id");--> statement-breakpoint
CREATE INDEX "fundamental_statements_reported_idx" ON "fundamental_statements" USING btree ("instrument_id","reported_at");--> statement-breakpoint
CREATE INDEX "option_quotes_snapshot_date_idx" ON "option_quotes" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "positions_open_instrument_idx" ON "positions" USING btree ("instrument_id") WHERE "positions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "recommendations_as_of_composite_idx" ON "recommendations" USING btree ("as_of","composite" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skill_runs_as_of_skill_idx" ON "skill_runs" USING btree ("as_of","skill_id");