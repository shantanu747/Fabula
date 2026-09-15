import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { decodeCursor, getLibraryPage } from "@/lib/db/feedAndLibrary";
import { isUniqueViolation } from "@/lib/db/paragraphs";
import { PRIVATE_NO_STORE } from "@/lib/http/cacheControl";
import { readJsonBody } from "@/lib/http/readJsonBody";
import { areValidHints, isValidTargetLength } from "@/lib/story/validation";
import { guardStoriesRead, guardStoriesWrite } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { assertSessionCurrent } from "@/lib/auth/tokenVersion";

interface CreateStoryBody {
  theme?: string;
  characters?: string;
  openingLines?: string;
  targetLength: number;
  selectedProviderId: string;
}

function isValidBody(body: unknown): body is CreateStoryBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    areValidHints(b) && isValidTargetLength(b.targetLength) && typeof b.selectedProviderId === "string"
  );
}

/** Generous — a UUID (what the client actually sends) is 36 characters; this
 *  just bounds an arbitrary header from reaching the query, the same
 *  "trust nothing client-supplied" posture as the body guards above. Absent,
 *  empty, or oversized all fall back to `undefined` — a bare, non-idempotent
 *  insert, exactly today's behavior — rather than a 400: a malformed or
 *  missing header on this specific route is a degraded guarantee, not a
 *  request the server can't otherwise fulfill. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function readIdempotencyKey(request: Request): string | undefined {
  const header = request.headers.get("Idempotency-Key");
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "" || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return undefined;
  return trimmed;
}

export async function POST(request: Request) {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const revoked = await assertSessionCurrent(session.user);
  if (revoked) return revoked;
  const limited = await guardStoriesWrite(session.user.id);
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (!isValidBody(parsed.body)) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.body;

  const idempotencyKey = readIdempotencyKey(request);
  const db = getDb();

  try {
    const [story] = await db
      .insert(stories)
      .values({
        ownerId: session.user.id,
        theme: body.theme,
        characters: body.characters,
        openingLines: body.openingLines,
        targetLength: body.targetLength,
        selectedProviderId: body.selectedProviderId,
        idempotencyKey,
      })
      .returning({ id: stories.id });

    return Response.json({ id: story.id }, { status: 201 });
  } catch (err) {
    // A null idempotencyKey never collides — Postgres's unique constraint
    // treats every null as distinct from every other null (the same reason
    // the schema needs no special-casing to let un-keyed rows coexist), so a
    // 23505 here can only mean a replayed key from this same owner
    // (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md).
    if (idempotencyKey === undefined || !isUniqueViolation(err)) throw err;

    // The conflicting insert can only fail after the row it collided with has
    // committed — same reasoning as syncStoryParagraphs' 23505 handling
    // (docs/adr/0013): the unique index blocks until the other transaction
    // commits, so this read is guaranteed to see it.
    const [existing] = await db
      .select({ id: stories.id })
      .from(stories)
      .where(and(eq(stories.ownerId, session.user.id), eq(stories.idempotencyKey, idempotencyKey)));

    if (!existing) {
      // Unreachable per the above — surfaced as a clean error rather than a
      // crash on a bad assertion if it somehow ever is.
      return Response.json({ error: "Story creation conflict could not be resolved" }, { status: 500 });
    }

    return Response.json({ id: existing.id }, { status: 200 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardStoriesRead(session.user.id);
  if (limited) return limited;

  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (rawCursor !== null && cursor === undefined) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }

  const { rows, nextCursor } = await getLibraryPage(getDb(), session.user.id, cursor);
  return Response.json({ stories: rows, nextCursor }, { headers: { "Cache-Control": PRIVATE_NO_STORE } });
}
