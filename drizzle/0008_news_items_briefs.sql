CREATE TABLE "news_briefs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "news_briefs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"day" date NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"session" text NOT NULL,
	"lead" text NOT NULL,
	"bullets" jsonb NOT NULL,
	"for_puts" text NOT NULL,
	"tape" jsonb NOT NULL,
	"citations" jsonb NOT NULL,
	"model" text,
	"cost_usd" numeric(10, 4),
	CONSTRAINT "news_briefs_session_check" CHECK ("news_briefs"."session" in ('hk_open','us_open','manual'))
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "news_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"snippet" text,
	"published_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"ai_impact" text,
	"ai_summary" text,
	"ai_rules" jsonb,
	"ai_standing" jsonb,
	"ai_confidence" smallint,
	"ai_known_at" timestamp with time zone,
	"ai_model" text,
	"ai_cost_usd" numeric(10, 4),
	CONSTRAINT "news_items_instrument_hash_key" UNIQUE NULLS NOT DISTINCT("instrument_id","hash"),
	CONSTRAINT "news_items_impact_check" CHECK ("news_items"."ai_impact" is null or "news_items"."ai_impact" in ('supports','caution','blocks','neutral')),
	CONSTRAINT "news_items_summary_check" CHECK ("news_items"."ai_summary" is null or char_length("news_items"."ai_summary") <= 240)
);
--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_briefs_day_idx" ON "news_briefs" USING btree ("day","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "news_briefs_scheduled_key" ON "news_briefs" USING btree ("day","session") WHERE "news_briefs"."session" <> 'manual';--> statement-breakpoint
CREATE INDEX "news_items_published_idx" ON "news_items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "news_items_instrument_published_idx" ON "news_items" USING btree ("instrument_id","published_at");