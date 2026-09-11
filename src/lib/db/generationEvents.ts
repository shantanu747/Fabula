import { and, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
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
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
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

/**
 * The three totals the budget module (`src/lib/budget/`) reconciles Redis's
 * accelerator counters against (docs/adr/0036) — the source of truth on a
 * cold key. Three distinct populations, not one parameterised by an optional
 * `userId`: "one Writer's spend", "every guest's spend combined" (guests have
 * no account, so no `userId` to filter on — this is exactly the population
 * the shared guest budget governs), and "everyone's spend combined", which
 * needs no `userId` predicate at all rather than an OR of the other two.
 * Collapsing these into one ambiguous `userId: string | undefined` parameter
 * is exactly the kind of mistake that would silently under-count the global
 * cap by excluding every signed-in Writer's spend from it.
 *
 * Per-user is served by `generation_event_userId_createdAt_index`; guest and
 * global are both served by the plain `createdAt` index.
 */
export async function sumUserCostSince(db: AppDatabase, userId: string, since: Date): Promise<number> {
  return sumCostWhere(db, and(eq(generationEvents.userId, userId), gte(generationEvents.createdAt, since)));
}

export async function sumGuestCostSince(db: AppDatabase, since: Date): Promise<number> {
  return sumCostWhere(db, and(isNull(generationEvents.userId), gte(generationEvents.createdAt, since)));
}

export async function sumGlobalCostSince(db: AppDatabase, since: Date): Promise<number> {
  return sumCostWhere(db, gte(generationEvents.createdAt, since));
}

async function sumCostWhere(db: AppDatabase, where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${generationEvents.costUsd}), 0)` })
    .from(generationEvents)
    .where(where);
  return Number(row?.total ?? 0);
}
