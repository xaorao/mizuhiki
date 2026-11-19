CREATE TABLE "snapshots" (
	"hash" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"form_id" text NOT NULL,
	"title" text NOT NULL,
	"sig" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "snapshots_owner_form" ON "snapshots" USING btree ("owner","form_id","created_at");