CREATE TABLE "leaders_candidates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "leaders_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"instrument_id" bigint NOT NULL,
	"rank" smallint,
	"state" text NOT NULL,
	"score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"payload" jsonb NOT NULL,
	"brief_line" text,
	"fwd5" numeric(9, 5),
	"fwd10" numeric(9, 5),
	"fwd20" numeric(9, 5),
	"hit_3r" boolean,
	"stopped" boolean,
	"max_r" numeric(8, 3),
	"days_to_3r" smallint,
	"outcome_as_of" date,
	CONSTRAINT "leaders_candidates_run_instrument_key" UNIQUE("run_id","instrument_id"),
	CONSTRAINT "leaders_candidates_state_check" CHECK ("leaders_candidates"."state" in ('setup','watch','extended','broken','excluded'))
);
--> statement-breakpoint
CREATE TABLE "leaders_mutes" (
	"instrument_id" bigint PRIMARY KEY NOT NULL,
	"until" date NOT NULL,
	"reason" text DEFAULT 'dismissed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaders_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "leaders_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"market" "market" NOT NULL,
	"as_of" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"screened" integer DEFAULT 0 NOT NULL,
	"leaders" integer DEFAULT 0 NOT NULL,
	"consolidating" integer DEFAULT 0 NOT NULL,
	"shortlisted" integer DEFAULT 0 NOT NULL,
	"regime" text,
	"posture" text DEFAULT 'entries' NOT NULL,
	"params_hash" text NOT NULL,
	"skill_version" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brief_lead" text,
	"brief_model" text,
	"brief_cost_usd" numeric(10, 4),
	CONSTRAINT "leaders_runs_status_check" CHECK ("leaders_runs"."status" in ('running','ok','partial','failed')),
	CONSTRAINT "leaders_runs_posture_check" CHECK ("leaders_runs"."posture" in ('entries','watch_only'))
);
--> statement-breakpoint
CREATE TABLE "universe_members" (
	"instrument_id" bigint NOT NULL,
	"index_code" text NOT NULL,
	"added_at" date NOT NULL,
	"removed_at" date,
	CONSTRAINT "universe_members_instrument_id_index_code_pk" PRIMARY KEY("instrument_id","index_code"),
	CONSTRAINT "universe_members_index_check" CHECK ("universe_members"."index_code" in ('SPX','NDX','MID','HSI','HSCEI','HSTECH','HSCI'))
);
--> statement-breakpoint
ALTER TABLE "leaders_candidates" ADD CONSTRAINT "leaders_candidates_run_id_leaders_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."leaders_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaders_candidates" ADD CONSTRAINT "leaders_candidates_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaders_mutes" ADD CONSTRAINT "leaders_mutes_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_members" ADD CONSTRAINT "universe_members_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaders_candidates_instrument_idx" ON "leaders_candidates" USING btree ("instrument_id","run_id");--> statement-breakpoint
CREATE INDEX "leaders_runs_market_day_idx" ON "leaders_runs" USING btree ("market","as_of","started_at");--> statement-breakpoint
CREATE INDEX "universe_members_index_idx" ON "universe_members" USING btree ("index_code");