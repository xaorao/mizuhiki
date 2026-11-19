CREATE TABLE "discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"code" text NOT NULL,
	"percent" integer,
	"amount_off" text,
	"token" text,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_slots" (
	"product_id" text NOT NULL,
	"slot" text NOT NULL,
	"order_ref" text NOT NULL,
	CONSTRAINT "order_slots_product_id_slot_pk" PRIMARY KEY("product_id","slot")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"ref" text PRIMARY KEY NOT NULL,
	"seller" text NOT NULL,
	"request" jsonb NOT NULL,
	"token" text NOT NULL,
	"total" text NOT NULL,
	"due_now" text NOT NULL,
	"due_later" text NOT NULL,
	"recipient_address" text,
	"recipient_key_hash" text,
	"discount_id" text,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"payer" text,
	"deposit_tx" text,
	"balance_tx" text,
	"refund_tx" text,
	"delivery" text,
	"delivered_by" text,
	"review_hash" text NOT NULL,
	"balance_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"record" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"draft_envelope" text NOT NULL,
	"agent_envelope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"order_ref" text NOT NULL,
	"product_id" text NOT NULL,
	"seller" text NOT NULL,
	"rating" integer NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_order_ref_product_id_pk" PRIMARY KEY("order_ref","product_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_owner_code" ON "discounts" USING btree ("owner","code");--> statement-breakpoint
CREATE INDEX "orders_seller" ON "orders" USING btree ("seller","created_at");--> statement-breakpoint
CREATE INDEX "orders_recipient" ON "orders" USING btree ("recipient_address");--> statement-breakpoint
CREATE INDEX "orders_key" ON "orders" USING btree ("recipient_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "products_owner_slug" ON "products" USING btree ("owner","slug");--> statement-breakpoint
CREATE INDEX "products_owner" ON "products" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "reviews_product" ON "reviews" USING btree ("product_id");