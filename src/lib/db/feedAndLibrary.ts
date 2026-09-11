import { and, desc, eq, lt, or } from "drizzle-orm";
import { stories, users } from "./schema";
import type { AppDatabase } from "./types";

/**
 * Shared by the feed and library API routes and their RSC pages
 * (docs/adr/0041) — before this, `src/app/api/stories/route.ts` and
 * `src/app/library/page.tsx` (and likewise the feed's route/page) each had
 * their own copy of the same query, which is exactly how they drifted:
 * `queries.perf.test.ts` was asserting on a third, hand-written stand-in that
 * matched neither. Importing these functions is what stops that recurring.
 */

export const PAGE_SIZE = 20;

export interface KeysetCursor {
  updatedAt: Date;
  id: string;
}

/** Opaque to the client by design (docs/plans/v4/03) — validated only by
 *  round-tripping through decodeCursor, never parsed for its contents. */
export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): KeysetCursor | undefined {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return undefined;
    const updatedAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(updatedAt.getTime()) || id.length === 0) return undefined;
    return { updatedAt, id };
  } catch {
    return undefined;
  }
}

/**
 * `(updatedAt, id) < (cursor.updatedAt, cursor.id)` — the standard keyset
 * split into two OR'd clauses, matching the `(updatedAt DESC, id DESC)`
 * ordering both indexes provide. "Less than" (not "greater than") because
 * DESC order means the *next* page holds smaller values than the cursor.
 */
function pageBoundary(cursor: KeysetCursor | undefined) {
  if (!cursor) return undefined;
  return or(
    lt(stories.updatedAt, cursor.updatedAt),
    and(eq(stories.updatedAt, cursor.updatedAt), lt(stories.id, cursor.id))
  );
}

export interface LibraryRow {
  id: string;
  theme: string | null;
  characters: string | null;
  targetLength: number;
  isShared: boolean;
  updatedAt: Date;
  paragraphCount: number;
}

/**
 * The query itself, unawaited — exported separately from getLibraryPage so
 * queries.perf.test.ts can call `.toSQL()` on exactly what production runs
 * and EXPLAIN it, rather than maintaining a hand-written stand-in that can
 * drift from this file (docs/adr/0041, the defect ADR 0017 already found
 * once with the old stand-in).
 */
export function buildLibraryQuery(db: AppDatabase, ownerId: string, cursor?: KeysetCursor) {
  return db
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      targetLength: stories.targetLength,
      isShared: stories.isShared,
      updatedAt: stories.updatedAt,
      paragraphCount: stories.paragraphCount,
    })
    .from(stories)
    .where(and(eq(stories.ownerId, ownerId), pageBoundary(cursor)))
    .orderBy(desc(stories.updatedAt), desc(stories.id))
    .limit(PAGE_SIZE + 1);
}

/** One Writer's stories, newest-first. Reads `paragraphCount` off the story
 *  row directly — no join, no groupBy (docs/adr/0041). */
export async function getLibraryPage(
  db: AppDatabase,
  ownerId: string,
  cursor?: KeysetCursor
): Promise<{ rows: LibraryRow[]; nextCursor: string | null }> {
  return toPage(await buildLibraryQuery(db, ownerId, cursor));
}

export interface FeedRow {
  id: string;
  theme: string | null;
  characters: string | null;
  authorName: string | null;
  updatedAt: Date;
  paragraphCount: number;
}

/** Same reasoning as buildLibraryQuery above. */
export function buildFeedQuery(db: AppDatabase, cursor?: KeysetCursor) {
  return db
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      authorName: users.name,
      updatedAt: stories.updatedAt,
      paragraphCount: stories.paragraphCount,
    })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.ownerId))
    .where(and(eq(stories.isShared, true), pageBoundary(cursor)))
    .orderBy(desc(stories.updatedAt), desc(stories.id))
    .limit(PAGE_SIZE + 1);
}

/** Every shared story, newest-first, with its Writer's display name. */
export async function getFeedPage(
  db: AppDatabase,
  cursor?: KeysetCursor
): Promise<{ rows: FeedRow[]; nextCursor: string | null }> {
  return toPage(await buildFeedQuery(db, cursor));
}

function toPage<T extends { updatedAt: Date; id: string }>(
  rows: T[]
): { rows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null };
}
