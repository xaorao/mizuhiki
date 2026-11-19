CREATE TABLE "pass_items" (
	"pass_id" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"envelope" text NOT NULL,
	"item_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_items_pass_id_source_pk" PRIMARY KEY("pass_id","source")
);
--> statement-breakpoint
CREATE TABLE "passes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"holder" text NOT NULL,
	"invite" jsonb NOT NULL,
	"accept" jsonb,
	"status" text DEFAULT 'invited' NOT NULL,
	"key_index" integer,
	"key_envelope" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "passes_owner" ON "passes" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "passes_holder" ON "passes" USING btree ("holder");--> statement-breakpoint
CREATE UNIQUE INDEX "passes_owner_key" ON "passes" USING btree ("owner","key_index");