import { asc, eq, sql } from "drizzle-orm";
import { stories, storyParagraphs } from "./schema";
import type { AppDatabase } from "./types";
import type { StoryParagraph } from "@/lib/providers/types";

/** Postgres unique_violation (SQLSTATE 23505). */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps every driver error in DrizzleQueryError with the original on
 * `.cause`, so a top-level `err.code` check never matches. Both
 * @neondatabase/serverless's NeonDbError and pg's DatabaseError carry `.code`,
 * so walking the chain works identically on either driver.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; depth++) {
    if (typeof e === "object" && "code" in e && (e as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Appends at the exact positions the caller validated against, starting at
 * `basePosition`.
 *
 * The positions are asserted, never re-derived. An earlier version computed
 * `coalesce(max("position") + 1, 0)` inside this statement, which reads as the
 * safer choice and is in fact the bug: a request that lost the race would
 * recompute a fresh maximum at write time, find no conflict, and quietly append
 * its stale paragraph *after* the winner's. The story ended up with two Writer
 * paragraphs in a row and a client whose positions no longer matched the
 * server's — the exact interleaving the constraint exists to stop, slipping
 * past it because nothing ever collided.
 *
 * Writing the validated positions literally is what turns the unique index into
 * the serialization point: whoever reads second collides, raises 23505, and is
 * sent back through the prefix check by the caller.
 */
async function appendParagraphsOnce(
  db: AppDatabase,
  storyId: string,
  paragraphs: readonly StoryParagraph[],
  basePosition: number
): Promise<void> {
  // One bound parameter per field — no Postgres array-literal encoding of Writer
  // prose. The ::text casts are on every row because an all-parameter VALUES list
  // otherwise fails with "could not determine data type of parameter".
  const rows = paragraphs.map(
    (p, i) => sql`(${crypto.randomUUID()}::text, ${storyId}::text, ${p.author}::text, ${
      p.text
    }::text, ${p.providerId ?? null}::text, ${basePosition + i}::int)`
  );

  await db.execute(sql`
    insert into ${storyParagraphs}
      ("id", "storyId", "authorType", "text", "providerId", "position")
    values ${sql.join(rows, sql`, `)}
  `);
}

export async function insertAIParagraph(
  db: AppDatabase,
  args: { storyId: string; text: string; providerId: string; position: number;
          invented?: { theme?: string; characters?: string } }
): Promise<boolean> {
  const inventedSql = args.invented
    ? sql`, "invented" = ${JSON.stringify(args.invented)}::jsonb`
    : sql``;

  const result = await db.execute<{ id: string }>(sql`
    with ins as (
      insert into ${storyParagraphs}
        ("id", "storyId", "authorType", "text", "providerId", "position")
      values (${crypto.randomUUID()}, ${args.storyId}, 'ai', ${args.text},
              ${args.providerId}, ${args.position})
      on conflict ("storyId", "position") do nothing
      returning "id"
    )
    update ${stories}
       set "updatedAt" = (now() at time zone 'utc')${inventedSql}
     where "id" = ${args.storyId} and exists (select 1 from ins)
    returning "id"
  `);

  // false = a concurrent turn already took this position. Not an error: this
  // generation was superseded. Caller logs and lets the stream finish.
  return result.rows.length > 0;
}

export type SyncResult =
  | { ok: true; storedBefore: number; appended: number; nextPosition: number }
  | { ok: false; reason: "diverged" };

const MAX_SYNC_ATTEMPTS = 3;

export async function syncStoryParagraphs(
  db: AppDatabase,
  storyId: string,
  clientParagraphs: readonly StoryParagraph[]
): Promise<SyncResult> {
  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    const stored = await db
      .select({
        position: storyParagraphs.position,
        authorType: storyParagraphs.authorType,
        text: storyParagraphs.text,
      })
      .from(storyParagraphs)
      .where(eq(storyParagraphs.storyId, storyId))
      .orderBy(asc(storyParagraphs.position));

    // The client array must EXTEND what's stored, not contradict it. This is the
    // check the old slice(storedCount) was missing — it compared lengths only.
    const isPrefix =
      stored.length <= clientParagraphs.length &&
      stored.every(
        (s, i) => s.text === clientParagraphs[i].text && s.authorType === clientParagraphs[i].author
      );
    if (!isPrefix) return { ok: false, reason: "diverged" };

    const toAppend = clientParagraphs.slice(stored.length);
    if (toAppend.length === 0) {
      // Defense in depth against impossible stored state: if nothing is being
      // appended then the stored story equals the client's, and the route has
      // already rejected a client array ending in an AI paragraph. A stored
      // story that ends with one anyway means the mirror is corrupt, so refuse
      // rather than stack a second AI turn on top of it.
      //
      // This is documentation, not enforcement. It is still a read, so two
      // concurrent requests can both pass it; only the unique constraint on the
      // write actually serializes turns (docs/adr/0013).
      if (stored.length > 0 && stored[stored.length - 1].authorType === "ai") {
        return { ok: false, reason: "diverged" };
      }
      return { ok: true, storedBefore: stored.length, appended: 0, nextPosition: stored.length };
    }

    try {
      await appendParagraphsOnce(db, storyId, toAppend, stored.length);
      return {
        ok: true,
        storedBefore: stored.length,
        appended: toAppend.length,
        nextPosition: stored.length + toAppend.length,
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Someone appended between our read and our insert. No backoff needed:
      // 23505 only surfaces after the conflicting transaction committed (the
      // index insert blocks until then), so the next read sees its rows.
    }
  }
  return { ok: false, reason: "diverged" };
}
