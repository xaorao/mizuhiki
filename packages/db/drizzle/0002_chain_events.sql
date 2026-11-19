CREATE TABLE "chain_events" (
	"contract" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"time" timestamp with time zone,
	CONSTRAINT "chain_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "chain_events_event" ON "chain_events" USING btree ("event","block");