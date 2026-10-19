CREATE TABLE "stock_lots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_lots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instrument_id" bigint NOT NULL,
	"position_id" bigint,
	"shares" integer NOT NULL,
	"cost_basis" numeric(18, 6) NOT NULL,
	"open_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"close_date" date,
	"close_price" numeric(18, 6),
	"realized_pnl" numeric(18, 6),
	"notes" text,
	CONSTRAINT "stock_lots_position_key" UNIQUE("position_id"),
	CONSTRAINT "stock_lots_status_check" CHECK ("stock_lots"."status" in ('open','sold')),
	CONSTRAINT "stock_lots_shares_check" CHECK ("stock_lots"."shares" > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_lots_open_idx" ON "stock_lots" USING btree ("instrument_id") WHERE "stock_lots"."status" = 'open';