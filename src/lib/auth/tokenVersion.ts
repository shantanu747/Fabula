import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";

/**
 * Session revocation (docs/adr/0047). `user.tokenVersion` is stamped into the
 * JWT at sign-in; a mismatch against the live value means every session
 * issued before the bump (a password reset, today) is dead. Checked only on
 * mutating routes, deliberately never on a page render — see the ADR for why
 * a per-render check was rejected even at this app's small scale, and what
 * residual exposure that leaves (bounded by `session.maxAge` instead).
 */

const CACHE_TTL_SECONDS = 60;

function cacheKey(userId: string): string {
  return `tokenver:${userId}`;
}

async function readCached(userId: string): Promise<number | undefined> {
  if (!hasKv()) return undefined;
  const cached = await withKvTimeout(() => getKv().get<number>(cacheKey(userId)));
  return cached ?? undefined;
}

async function writeCached(userId: string, version: number): Promise<void> {
  if (!hasKv()) return;
  await withKvTimeout(() => getKv().set(cacheKey(userId), version, { ex: CACHE_TTL_SECONDS }));
}

/** Undefined means the user row no longer exists — treated as revoked by
 *  every caller, since there is no live version left to match against. */
export async function getCurrentTokenVersion(userId: string): Promise<number | undefined> {
  const cached = await readCached(userId);
  if (cached !== undefined) return cached;

  const [row] = await getDb().select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId));
  if (!row) return undefined;

  await writeCached(userId, row.tokenVersion);
  return row.tokenVersion;
}

/** Called wherever a session must die immediately — today, only a completed
 *  password reset. Deletes the cache entry rather than writing the new value
 *  directly: the Postgres UPDATE...RETURNING already has the fresh number,
 *  but a concurrent bump (two reset requests racing) would let a stale write
 *  here clobber a newer one — a delete just forces the next read to reload
 *  from Postgres, which is always correct. */
export async function bumpTokenVersion(userId: string): Promise<void> {
  await getDb()
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));

  if (hasKv()) {
    await withKvTimeout(() => getKv().del(cacheKey(userId)));
  }
}

/**
 * The one check every mutating route makes right after confirming a session
 * exists. Returns the 401 to send back, or null to proceed — same
 * Response-or-null convention as src/lib/ratelimit/guard.ts.
 */
export async function assertSessionCurrent(sessionUser: {
  id: string;
  tokenVersion: number;
}): Promise<Response | null> {
  const current = await getCurrentTokenVersion(sessionUser.id);
  if (current === undefined || current !== sessionUser.tokenVersion) {
    return Response.json(
      { error: "Your session is no longer valid. Please sign in again." },
      { status: 401 }
    );
  }
  return null;
}
