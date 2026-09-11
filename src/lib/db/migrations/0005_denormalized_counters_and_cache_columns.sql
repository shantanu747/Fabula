DROP INDEX "story_ownerId_updatedAt_index";--> statement-breakpoint
DROP INDEX "stories_updated_at_is_shared_idx";--> statement-breakpoint
ALTER TABLE "generation_event" ADD COLUMN "cacheReadInputTokens" integer;--> statement-breakpoint
ALTER TABLE "generation_event" ADD COLUMN "cacheCreationInputTokens" integer;--> statement-breakpoint
ALTER TABLE "story" ADD COLUMN "paragraphCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "story" ADD COLUMN "contentHash" text;--> statement-breakpoint
-- Backfill paragraphCount for rows written before this column existed, so the
-- library/feed (which now read this column directly instead of a groupBy/count
-- join) don't regress to showing 0 paragraphs for every pre-existing story.
-- Unbatched, like migration 0001's position-renumbering backfill — acceptable
-- at this size (one aggregate scan of story_paragraph, not a per-row update).
--
-- contentHash is deliberately left NULL here rather than recomputed. It drives
-- only a fast-path *optimization* in src/lib/db/paragraphs.ts's hash check: a
-- NULL never matches a client's real (JS-computed) hash, so a pre-existing
-- story's next turn simply falls back to the always-correct row-by-row
-- comparison, which then writes the real hash going forward in the same
-- statement as the paragraphs (docs/adr/0041). Computing a hash here instead
-- would mean a second, separately-fallible reimplementation of the shared
-- hash algorithm in raw SQL, for a value only ever compared against the JS one
-- — exactly the "hash computed two different ways" trap the shared module
-- exists to avoid.
WITH counts AS (
  SELECT "storyId", count(*) AS n
    FROM "story_paragraph"
   GROUP BY "storyId"
)
UPDATE "story" AS s
   SET "paragraphCount" = counts.n
  FROM counts
 WHERE s."id" = counts."storyId";
--> statement-breakpoint
CREATE INDEX "generation_event_storyId_index" ON "generation_event" USING btree ("storyId");--> statement-breakpoint
CREATE INDEX "story_ownerId_updatedAt_id_index" ON "story" USING btree ("ownerId","updatedAt" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "stories_updated_at_id_is_shared_idx" ON "story" USING btree ("updatedAt" DESC,"id" DESC) WHERE "isShared" = true;