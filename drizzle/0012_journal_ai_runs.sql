CREATE TABLE "journal_ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"instruction" text,
	"with_context" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"input_markdown" text NOT NULL,
	"output_markdown" text,
	"output_doc" jsonb,
	"accepted" boolean,
	"model" text,
	"cost_usd" numeric(10, 4),
	"duration_ms" integer,
	"error" text,
	"locked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "journal_ai_runs_mode_check" CHECK ("journal_ai_runs"."mode" in ('polish','tighten','structure','lessons','translate_zh','translate_en','custom')),
	CONSTRAINT "journal_ai_runs_status_check" CHECK ("journal_ai_runs"."status" in ('queued','running','done','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "journal_ai_runs" ADD CONSTRAINT "journal_ai_runs_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_ai_runs" ADD CONSTRAINT "journal_ai_runs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_ai_runs_entry_idx" ON "journal_ai_runs" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "journal_ai_runs_user_day_idx" ON "journal_ai_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_ai_runs_one_active_key" ON "journal_ai_runs" USING btree ("entry_id") WHERE "journal_ai_runs"."status" in ('queued','running');