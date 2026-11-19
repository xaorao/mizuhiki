CREATE TABLE "room_batches" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "room_batches_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"room_id" text NOT NULL,
	"hash" text NOT NULL,
	"epoch" integer NOT NULL,
	"size" integer NOT NULL,
	"delete_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_epochs" (
	"room_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"distribution" text NOT NULL,
	"membership_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"by" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_epochs_room_id_epoch_pk" PRIMARY KEY("room_id","epoch")
);
--> statement-breakpoint
CREATE TABLE "room_history" (
	"room_id" text NOT NULL,
	"member" text NOT NULL,
	"envelope" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_history_room_id_member_envelope_pk" PRIMARY KEY("room_id","member","envelope")
);
--> statement-breakpoint
CREATE TABLE "room_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"card" text NOT NULL,
	"created_by" text NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"address" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"permissions" jsonb DEFAULT '["send","files","add","info","pin"]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_epoch" integer NOT NULL,
	"last_epoch" integer,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_address_pk" PRIMARY KEY("room_id","address")
);
--> statement-breakpoint
CREATE TABLE "room_requests" (
	"room_id" text NOT NULL,
	"address" text NOT NULL,
	"invite_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_requests_room_id_address_pk" PRIMARY KEY("room_id","address")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"owner" text NOT NULL,
	"epoch" integer NOT NULL,
	"approval" boolean DEFAULT true NOT NULL,
	"auto_delete_seconds" integer DEFAULT 0 NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "room_batches_room" ON "room_batches" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "room_batches_hash" ON "room_batches" USING btree ("room_id","hash");--> statement-breakpoint
CREATE INDEX "room_invites_room" ON "room_invites" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_members_address" ON "room_members" USING btree ("address");