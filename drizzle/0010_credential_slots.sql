ALTER TABLE "encryption_key_slots" ADD COLUMN "kind" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "encryption_key_slots" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "encryption_key_slots" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encryption_key_slots" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encryption_key_slots" ADD CONSTRAINT "encryption_key_slots_kind_check" CHECK ("encryption_key_slots"."kind" IN ('password', 'session', 'api_token'));