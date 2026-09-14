ALTER TABLE "story" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_ownerId_idempotencyKey_unique" UNIQUE("ownerId","idempotencyKey");