CREATE TABLE "fair_values" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fair_values_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"as_of" date NOT NULL,
	"value" numeric(18, 6) NOT NULL,
	"source" text DEFAULT 'morningstar_csv' NOT NULL,
	"moat" text,
	"uncertainty" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fair_values_key" UNIQUE("instrument_id","as_of","source")
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" bigint NOT NULL,
	"skill_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"step_index" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(10, 4),
	"model" text,
	"error" text,
	"report_path" text,
	"result" jsonb,
	CONSTRAINT "research_runs_status_check" CHECK ("research_runs"."status" in ('queued','running','done','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "valuation_overrides" (
	"instrument_id" bigint PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fair_values" ADD CONSTRAINT "fair_values_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_overrides" ADD CONSTRAINT "valuation_overrides_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_runs_instrument_idx" ON "research_runs" USING btree ("instrument_id","created_at");