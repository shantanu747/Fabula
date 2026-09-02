CREATE TABLE "generation_event" (
	"id" text PRIMARY KEY NOT NULL,
	"requestId" text NOT NULL,
	"providerId" text NOT NULL,
	"model" text NOT NULL,
	"userId" text,
	"storyId" text,
	"inputTokens" integer,
	"outputTokens" integer,
	"costUsd" double precision,
	"ttftMs" integer,
	"totalMs" integer,
	"outcome" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_event" ADD CONSTRAINT "generation_event_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_event" ADD CONSTRAINT "generation_event_storyId_story_id_fk" FOREIGN KEY ("storyId") REFERENCES "public"."story"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_event_userId_index" ON "generation_event" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "generation_event_createdAt_index" ON "generation_event" USING btree ("createdAt");