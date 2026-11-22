CREATE TABLE "starter_grants" (
	"address" text PRIMARY KEY NOT NULL,
	"ip_hash" text NOT NULL,
	"amount" text NOT NULL,
	"tx_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "starter_grants_ip_idx" ON "starter_grants" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "starter_grants_at_idx" ON "starter_grants" USING btree ("created_at");