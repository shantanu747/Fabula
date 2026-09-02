import { generationEvents } from "./schema";
import type { AppDatabase } from "./types";

export interface GenerationEventInput {
  requestId: string;
  providerId: string;
  model: string;
  userId?: string;
  storyId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  ttftMs?: number;
  totalMs?: number;
  outcome: "success" | "provider_error" | "cancelled" | "persist_failed";
}

/**
 * A plain insert, unlike paragraphs.ts's conflict-aware writes — there's no
 * concurrent-turn race to serialize here, just one best-effort row per
 * generation. Callers (route.ts) are expected to swallow and log a failure
 * rather than let cost-history bookkeeping break the story stream.
 */
export async function insertGenerationEvent(
  db: AppDatabase,
  args: GenerationEventInput
): Promise<void> {
  await db.insert(generationEvents).values(args);
}
