import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";

/**
 * Closes ADR 0015's named gap: "nothing prunes [rate_limit_bucket rows]... a
 * periodic delete of rows untouched for a day is the obvious follow-up."
 *
 * Only Postgres buckets need this. A Redis-backed bucket (docs/adr/0035)
 * already carries its own `EXPIRE`, set to the time it takes to fully refill
 * from empty — an idle key just disappears. This route exists for the
 * fallback path, which is still load-bearing whenever Redis is absent,
 * unreachable, or a caller happens to fall through to it.
 */

/** One statement, bounded so pruning a large table can never become an
 *  unbounded one — a single run deletes at most this many rows; a cron that
 *  fires daily against realistic bucket volume never needs a second pass to
 *  catch up. */
const MAX_ROWS_PER_RUN = 10_000;

/** Hashed to a fixed length before comparison so a length mismatch between
 *  the caller's guess and the real secret can never itself leak by throwing
 *  (`timingSafeEqual` requires equal-length buffers) or by an early-exit
 *  string comparison's timing. */
function timingSafeEqualSecret(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Vercel Cron invokes a scheduled route with GET, not POST, and attaches
// `Authorization: Bearer $CRON_SECRET` itself when the project defines that
// env var — see vercel.json's `crons` entry for this route's schedule.
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/prune] CRON_SECRET is not configured — refusing to run");
    return Response.json({ error: "Not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!provided || !timingSafeEqualSecret(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasDatabase()) {
    return Response.json({ pruned: 0 });
  }

  const result = await getDb().execute<{ key: string }>(sql`
    delete from ${rateLimitBuckets}
     where "key" in (
       select "key" from ${rateLimitBuckets}
        where "updatedAt" < now() - interval '24 hours'
        limit ${MAX_ROWS_PER_RUN}
     )
    returning "key"
  `);

  return Response.json({ pruned: result.rows.length });
}
