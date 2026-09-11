DROP INDEX "generation_event_userId_index";--> statement-breakpoint
CREATE INDEX "generation_event_userId_createdAt_index" ON "generation_event" USING btree ("userId","createdAt" DESC);