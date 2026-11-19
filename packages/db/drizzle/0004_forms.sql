CREATE TABLE "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"slug" text NOT NULL,
	"draft_envelope" text,
	"record" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "forms_owner" ON "forms" USING btree ("owner");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_owner_slug" ON "forms" USING btree ("owner","slug");