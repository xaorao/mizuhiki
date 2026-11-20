CREATE TABLE "capsule_guardians" (
	"capsule_id" text NOT NULL,
	"guardian" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invite" jsonb NOT NULL,
	"accept" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_guardians_capsule_id_guardian_pk" PRIMARY KEY("capsule_id","guardian")
);
--> statement-breakpoint
CREATE TABLE "capsule_releases" (
	"capsule_id" text NOT NULL,
	"guardian" text NOT NULL,
	"recipient" text NOT NULL,
	"plan_version" integer NOT NULL,
	"envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_releases_capsule_id_guardian_recipient_pk" PRIMARY KEY("capsule_id","guardian","recipient")
);
--> statement-breakpoint
CREATE TABLE "capsules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"label" text NOT NULL,
	"draft_envelope" text NOT NULL,
	"plan" jsonb,
	"state" text DEFAULT 'draft' NOT NULL,
	"armed_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "capsule_guardians_guardian" ON "capsule_guardians" USING btree ("guardian");--> statement-breakpoint
CREATE INDEX "capsule_releases_recipient" ON "capsule_releases" USING btree ("recipient");--> statement-breakpoint
CREATE INDEX "capsules_owner" ON "capsules" USING btree ("owner");