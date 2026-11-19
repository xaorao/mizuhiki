CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"envelope" text,
	"private_envelope" text NOT NULL,
	"sig" jsonb,
	"state" text DEFAULT 'draft' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"viewed_at" timestamp with time zone,
	"recorded_paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "invoices_owner" ON "invoices" USING btree ("owner","created_at");