CREATE TABLE "recovery_answers" (
	"request_id" text NOT NULL,
	"contact" text NOT NULL,
	"envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_answers_request_id_contact_pk" PRIMARY KEY("request_id","contact")
);
--> statement-breakpoint
CREATE TABLE "recovery_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_contacts" (
	"owner" text NOT NULL,
	"contact" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invite" jsonb NOT NULL,
	"accept" jsonb,
	"piece" text,
	"piece_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_contacts_owner_contact_pk" PRIMARY KEY("owner","contact")
);
--> statement-breakpoint
CREATE TABLE "recovery_offline_items" (
	"owner" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"envelope" text NOT NULL,
	"item_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_offline_items_owner_source_pk" PRIMARY KEY("owner","source")
);
--> statement-breakpoint
CREATE TABLE "recovery_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"secret_hash" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"version" integer NOT NULL,
	"threshold" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_settings" (
	"owner" text PRIMARY KEY NOT NULL,
	"threshold" integer DEFAULT 2 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"sheet_saved_at" timestamp with time zone,
	"tested_at" timestamp with time zone,
	"offline_key" jsonb,
	"offline_sheet_saved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recovery_contacts_contact" ON "recovery_contacts" USING btree ("contact");--> statement-breakpoint
CREATE INDEX "recovery_requests_owner" ON "recovery_requests" USING btree ("owner");