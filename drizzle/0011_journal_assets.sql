CREATE TABLE "journal_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid,
	"kind" text DEFAULT 'image' NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_assets_user_sha_key" UNIQUE("user_id","sha256"),
	CONSTRAINT "journal_assets_kind_check" CHECK ("journal_assets"."kind" = 'image')
);
--> statement-breakpoint
ALTER TABLE "journal_assets" ADD CONSTRAINT "journal_assets_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_assets" ADD CONSTRAINT "journal_assets_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_assets_entry_idx" ON "journal_assets" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_assets_created_idx" ON "journal_assets" USING btree ("created_at");