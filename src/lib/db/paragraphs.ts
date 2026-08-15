import { and, asc, eq, sql } from "drizzle-orm";
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

async function appendParagraphsOnce(
  db: AppDatabase,
  storyId: string,
  paragraphs: readonly StoryParagraph[]
): Promise<{ firstPosition: number; nextPosition: number }> {
  // One bound parameter per field — no Postgres array-literal encoding of Writer
  // prose. The ::text casts are on every row because an all-parameter VALUES list
  // otherwise fails with "could not determine data type of parameter".
  const rows = paragraphs.map(
    (p, i) => sql`(${crypto.randomUUID()}::text, ${p.author}::text, ${p.text}::text, ${
      p.providerId ?? null
    }::text, ${i}::int)`
  );

  const result = await db.execute<{ position: number }>(sql`
    insert into ${storyParagraphs}
      ("id", "storyId", "authorType", "text", "providerId", "position")
    select v.id, ${storyId}, v.author_type, v.text, v.provider_id, base.next + v.ord
      from (values ${sql.join(rows, sql`, `)})
             as v (id, author_type, text, provider_id, ord)
      cross join (
        select coalesce(max("position") + 1, 0) as next
          from ${storyParagraphs}
         where "storyId" = ${storyId}
      ) as base
    returning "position"
  `);

  const positions = result.rows.map((r) => Number(r.position));
  const firstPosition = Math.min(...positions);
  return { firstPosition, nextPosition: firstPosition + positions.length };
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
      return { ok: true, storedBefore: stored.length, appended: 0, nextPosition: stored.length };
    }

    try {
      const { nextPosition } = await appendParagraphsOnce(db, storyId, toAppend);
      return { ok: true, storedBefore: stored.length, appended: toAppend.length, nextPosition };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Someone appended between our read and our insert. No backoff needed:
      // 23505 only surfaces after the conflicting transaction committed (the
      // index insert blocks until then), so the next read sees its rows.
    }
  }
  return { ok: false, reason: "diverged" };
}