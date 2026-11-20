CREATE TABLE "recovery_dismissals" (
	"request_id" text NOT NULL,
	"contact" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_dismissals_request_id_contact_pk" PRIMARY KEY("request_id","contact")
);
