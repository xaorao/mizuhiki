CREATE TABLE "file_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"record" jsonb NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "envelopes" ADD COLUMN "late" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "file_requests_owner" ON "file_requests" USING btree ("owner","created_at");