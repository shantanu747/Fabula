import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { insertGenerationEvent } from "./generationEvents";
import { generationEvents, users } from "./schema";
import { createStory, createUser } from "@/test/factories";

/**
 * Durable cost-history rows (docs/adr/0022). The one property worth proving
 * against a real Postgres rather than a fake: the deliberate onDelete "set
 * null" on userId/storyId, which diverges from every other table's cascade —
 * a stubbed db would only ever assert that the stub agrees with itself.
 */

async function readEvent(id: string) {
  const [row] = await getDb().select().from(generationEvents).where(eq(generationEvents.id, id));
  return row;
}

describe("insertGenerationEvent", () => {
  it("writes a full row for a persisted, successful generation", async () => {
    const user = await createUser();
    const story = await createStory(user.id);

    await insertGenerationEvent(getDb(), {
      requestId: "req-1",
      providerId: "anthropic",
      model: "claude-sonnet-5",
      userId: user.id,
      storyId: story.id,
      inputTokens: 120,
      outputTokens: 80,
      costUsd: 0.001,
      ttftMs: 250,
      totalMs: 900,
      outcome: "success",
    });

    const rows = await getDb().select().from(generationEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: "req-1",
      providerId: "anthropic",
      model: "claude-sonnet-5",
      userId: user.id,
      storyId: story.id,
      inputTokens: 120,
      outputTokens: 80,
      outcome: "success",
    });
  });

  it("writes a guest row with no userId or storyId", async () => {
    await insertGenerationEvent(getDb(), {
      requestId: "req-guest",
      providerId: "openai",
      model: "gpt-5-mini",
      outcome: "success",
    });

    const rows = await getDb().select().from(generationEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].storyId).toBeNull();
  });

  it("writes a row with no usage/cost for a provider error before the first chunk", async () => {
    await insertGenerationEvent(getDb(), {
      requestId: "req-fail",
      providerId: "anthropic",
      model: "unknown",
      outcome: "provider_error",
      totalMs: 50,
    });

    const rows = await getDb().select().from(generationEvents);
    expect(rows[0]).toMatchObject({
      outcome: "provider_error",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it("survives the user being deleted, with userId set to null — not cascaded away", async () => {
    const user = await createUser();
    await insertGenerationEvent(getDb(), {
      requestId: "req-2",
      providerId: "anthropic",
      model: "claude-sonnet-5",
      userId: user.id,
      outcome: "success",
    });
    const [event] = await getDb().select().from(generationEvents);

    await getDb().delete(users).where(eq(users.id, user.id));

    const survived = await readEvent(event.id);
    expect(survived).toBeDefined();
    expect(survived.userId).toBeNull();
  });

  it("survives the story being deleted, with storyId set to null — not cascaded away", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    await insertGenerationEvent(getDb(), {
      requestId: "req-3",
      providerId: "anthropic",
      model: "claude-sonnet-5",
      userId: user.id,
      storyId: story.id,
      outcome: "success",
    });
    const [event] = await getDb().select().from(generationEvents);

    await getDb().delete(users).where(eq(users.id, user.id)); // cascades to story

    const survived = await readEvent(event.id);
    expect(survived).toBeDefined();
    expect(survived.storyId).toBeNull();
    expect(survived.userId).toBeNull();
  });
});
