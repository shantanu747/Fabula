import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs, users } from "@/lib/db/schema";
import type { StoryParagraph } from "@/lib/providers/types";

/**
 * Row builders for the db suite. Every spec starts from a truncated database,
 * so these create exactly what a spec names and nothing else.
 */

export async function createUser(email = `writer-${crypto.randomUUID()}@example.com`) {
  const [user] = await getDb().insert(users).values({ email }).returning();
  return user;
}

export async function createStory(ownerId: string, overrides: Partial<typeof stories.$inferInsert> = {}) {
  const [story] = await getDb()
    .insert(stories)
    .values({
      ownerId,
      targetLength: 10,
      selectedProviderId: "anthropic",
      ...overrides,
    })
    .returning();
  return story;
}

/** Writes paragraphs at dense positions, as a healthy story always has them. */
export async function seedParagraphs(storyId: string, paragraphs: readonly StoryParagraph[]) {
  if (paragraphs.length === 0) return;
  await getDb()
    .insert(storyParagraphs)
    .values(
      paragraphs.map((p, position) => ({
        storyId,
        authorType: p.author,
        text: p.text,
        providerId: p.providerId ?? null,
        position,
      }))
    );
}

export async function readParagraphs(storyId: string) {
  return getDb()
    .select()
    .from(storyParagraphs)
    .where(eq(storyParagraphs.storyId, storyId))
    .orderBy(asc(storyParagraphs.position));
}
