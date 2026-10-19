ALTER TABLE "portfolio_settings" ADD COLUMN "daily_loss_limit" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "portfolio_settings" ADD COLUMN "consecutive_loss_halt" integer;--> statement-breakpoint
ALTER TABLE "portfolio_settings" ADD COLUMN "degear_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;