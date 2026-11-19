CREATE TABLE "media" (
	"hash" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
