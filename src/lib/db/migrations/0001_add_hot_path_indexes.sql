-- Postgres does not index foreign keys automatically. Each index below backs a
-- query on a request path, not a report.
CREATE INDEX "account_userId_index" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_index" ON "session" USING btree ("userId");--> statement-breakpoint
-- GET /api/stories, the library list. "ownerId" is the equality predicate and
-- "updatedAt" DESC supplies the ordering, so one index read serves both and the
-- LIMIT stops early. Note the absence of NULLS LAST: a plain ORDER BY ... DESC
-- means NULLS FIRST, and an index declared the other way cannot supply the sort
-- at all — the planner falls back to reading every one of a Writer's stories and
-- sorting them. Asserted in src/lib/db/queries.perf.test.ts.
CREATE INDEX "story_ownerId_updatedAt_index" ON "story" USING btree ("ownerId","updatedAt" DESC);--> statement-breakpoint
-- GET /api/feed reads only shared stories, a small fraction of the table, so the
-- index is partial and stays small enough to keep resident.
CREATE INDEX "stories_updated_at_is_shared_idx" ON "story" USING btree ("updatedAt") WHERE "isShared" = true;--> statement-breakpoint
CREATE INDEX "story_report_reporterId_index" ON "story_report" USING btree ("reporterId");--> statement-breakpoint

-- The unique constraint below is what makes concurrent paragraph positions safe
-- (docs/adr/0013). Rows written before it existed can already violate it: two
-- simultaneous /api/generate calls both read max(position) and both insert the
-- same number, so ADD CONSTRAINT would fail on any database that ever served
-- concurrent turns. Renumber first, into a dense deterministic 0..n-1 sequence
-- per story. Ordering by ("position", "createdAt", "id") preserves the intended
-- narrative order and breaks ties identically on every run, which makes this
-- statement a no-op the second time it is applied. It has to run before the
-- constraint exists — the intermediate states are only legal while duplicates
-- are still permitted.
WITH renumbered AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "storyId"
      ORDER BY "position", "createdAt", "id"
    ) - 1 AS new_position
  FROM "story_paragraph"
)
UPDATE "story_paragraph" AS p
   SET "position" = r.new_position
  FROM renumbered AS r
 WHERE p."id" = r."id"
   AND p."position" <> r.new_position;
--> statement-breakpoint
ALTER TABLE "story_paragraph" ADD CONSTRAINT "story_paragraph_storyId_position_unique" UNIQUE("storyId","position");
