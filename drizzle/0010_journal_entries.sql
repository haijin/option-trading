CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"title" text,
	"template" text,
	"market_view" text DEFAULT 'neutral' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"doc" jsonb NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"plain" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || plain)) STORED,
	"word_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision_no" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "journal_entries_user_date_key" UNIQUE("user_id","entry_date"),
	CONSTRAINT "journal_entries_template_check" CHECK ("journal_entries"."template" is null or "journal_entries"."template" in ('morning','evening','trade','weekly','free')),
	CONSTRAINT "journal_entries_market_view_check" CHECK ("journal_entries"."market_view" in ('bullish','neutral','bearish')),
	CONSTRAINT "journal_entries_status_check" CHECK ("journal_entries"."status" in ('draft','closed'))
);
--> statement-breakpoint
CREATE TABLE "journal_entry_instruments" (
	"entry_id" uuid NOT NULL,
	"instrument_id" bigint NOT NULL,
	CONSTRAINT "journal_entry_instruments_entry_id_instrument_id_pk" PRIMARY KEY("entry_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "journal_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"source" text NOT NULL,
	"ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_revisions_entry_no_key" UNIQUE("entry_id","revision_no"),
	CONSTRAINT "journal_revisions_source_check" CHECK ("journal_revisions"."source" in ('user','ai_accepted','restore','template'))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_instruments" ADD CONSTRAINT "journal_entry_instruments_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_instruments" ADD CONSTRAINT "journal_entry_instruments_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_revisions" ADD CONSTRAINT "journal_revisions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_search_idx" ON "journal_entries" USING gin ("search");--> statement-breakpoint
CREATE INDEX "journal_entries_user_date_idx" ON "journal_entries" USING btree ("user_id","entry_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entry_instruments_instrument_idx" ON "journal_entry_instruments" USING btree ("instrument_id");