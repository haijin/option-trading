CREATE TABLE "app_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_sessions_method_check" CHECK ("app_sessions"."method" in ('password','google','email_link','setup'))
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"google_sub" text,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "app_users_username_key" UNIQUE("username"),
	CONSTRAINT "app_users_email_key" UNIQUE("email"),
	CONSTRAINT "app_users_google_sub_key" UNIQUE("google_sub"),
	CONSTRAINT "app_users_lowercase_check" CHECK ("app_users"."username" = lower("app_users"."username") and "app_users"."email" = lower("app_users"."email"))
);
--> statement-breakpoint
CREATE TABLE "login_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_sessions_user_idx" ON "app_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_links_email_idx" ON "login_links" USING btree ("email","created_at");