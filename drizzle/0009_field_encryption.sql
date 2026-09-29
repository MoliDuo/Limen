CREATE TABLE "encryption_key_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"kdf" text NOT NULL,
	"kdf_params" text NOT NULL,
	"salt" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tags" DROP CONSTRAINT "tags_name_unique";--> statement-breakpoint
ALTER TABLE "tags" DROP CONSTRAINT "tags_name_length_check";--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "name_hmac" text;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_name_hmac_unique" UNIQUE("name_hmac");--> statement-breakpoint
-- The pre-0005 JSON tags column, held back in 0006. It is the last place tag
-- names survive in plaintext, so it goes with the release that encrypts them.
ALTER TABLE "entries" DROP COLUMN IF EXISTS "tags";