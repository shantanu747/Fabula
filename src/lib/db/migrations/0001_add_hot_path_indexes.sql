-- Migration to add unique constraint and indexes for performance
-- Adds UNIQUE constraint to prevent duplicate positions in stories and indexes for performance

-- Add unique constraint to prevent duplicate positions in stories
ALTER TABLE "story_paragraph" ADD CONSTRAINT "story_paragraph_storyId_position_unique" UNIQUE("storyId","position");

-- Add indexes for performance
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "story_ownerId_updatedAt_idx" ON "story" ("ownerId", "updatedAt" DESC);
CREATE INDEX "stories_updated_at_is_shared_idx" ON "story" ("updatedAt") WHERE "isShared" = true;
CREATE INDEX "story_report_reporterId_idx" ON "story_report" ("reporterId");