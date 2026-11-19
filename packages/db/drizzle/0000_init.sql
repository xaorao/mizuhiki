CREATE TABLE "accounts" (
	"address" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"address" text PRIMARY KEY NOT NULL,
	"card" jsonb NOT NULL,
	"card_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"owner" text NOT NULL,
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "counters_owner_day_kind_subject_pk" PRIMARY KEY("owner","day","kind","subject")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"address" text PRIMARY KEY NOT NULL,
	"blob_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"hash" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"size" integer NOT NULL,
	"readers" integer NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sender_sig" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "index_checkpoints" (
	"stream" text PRIMARY KEY NOT NULL,
	"position" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "names" (
	"name" text PRIMARY KEY NOT NULL,
	"name_hash" text NOT NULL,
	"address" text NOT NULL,
	"evm" text NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"claimed_tx" text NOT NULL,
	"claimed_block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_prefs" (
	"address" text PRIMARY KEY NOT NULL,
	"email" text,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"address" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"record" jsonb NOT NULL,
	"version" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_down" boolean DEFAULT false NOT NULL,
	"unpublished" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"tx_hash" text NOT NULL,
	"msg_index" integer NOT NULL,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"denom" text NOT NULL,
	"amount" text NOT NULL,
	"memo" text NOT NULL,
	"kind" text,
	"ref" text,
	"note_hash" text,
	"height" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_tx_hash_msg_index_pk" PRIMARY KEY("tx_hash","msg_index")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "envelopes_owner" ON "envelopes" USING btree ("owner","created_at");--> statement-breakpoint
CREATE INDEX "envelopes_ref" ON "envelopes" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "names_address" ON "names" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "names_hash" ON "names" USING btree ("name_hash");--> statement-breakpoint
CREATE INDEX "payments_to" ON "payments" USING btree ("to_addr","time");--> statement-breakpoint
CREATE INDEX "payments_ref" ON "payments" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "sessions_address" ON "sessions" USING btree ("address");