CREATE TABLE "blob_holds" (
	"hash" text NOT NULL,
	"holder" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_holds_hash_holder_purpose_pk" PRIMARY KEY("hash","holder","purpose")
);
--> statement-breakpoint
CREATE INDEX "blob_holds_hash" ON "blob_holds" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "blob_holds_holder" ON "blob_holds" USING btree ("holder","purpose");--> statement-breakpoint
-- Every blob keeps exactly the lifetime it had: its old expiry becomes one hold, released by no route.
INSERT INTO "blob_holds" ("hash", "holder", "purpose", "expires_at") SELECT "hash", 'system', 'migrated-0016', "expires_at" FROM "blobs";--> statement-breakpoint
ALTER TABLE "blobs" DROP COLUMN "expires_at";