import { sql } from "drizzle-orm";
import { rateLimitBuckets } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { bucketKey, retryAfterSeconds, type RateLimitPolicy } from "./policy";

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Takes one token from a caller's bucket, refilling it for elapsed time first.
 *
 * The whole algorithm is one statement, which is what makes it correct under
 * concurrency and what makes it work on this stack at all:
 *
 *  - Correctness. Read-then-write across two statements is the same TOCTOU that
 *    duplicated paragraph positions: two simultaneous requests both read four
 *    tokens left and both spend the fifth. Here the refill, the check, and the
 *    decrement are one INSERT ... ON CONFLICT DO UPDATE, and Postgres serialises
 *    conflicting upserts on the primary key — the second waits for the first to
 *    commit and then re-evaluates the WHERE against the row it actually wrote.
 *  - The driver. neon-http sends one statement per HTTP request with no session
 *    and no transactions (docs/adr/0013), so a lock, a SELECT ... FOR UPDATE, or
 *    a multi-statement transaction are all unavailable.
 *
 * When the WHERE fails there is nothing to update, the statement returns no
 * rows, and that absence is the denial.
 */
export async function consumeToken(
  db: AppDatabase,
  policy: RateLimitPolicy,
  identity: string
): Promise<RateLimitResult> {
  const key = bucketKey(policy, identity);
  const capacity = sql`${policy.capacity}::double precision`;
  const refill = sql`${policy.refillPerSecond}::double precision`;

  // now() is the transaction timestamp, so every mention inside one statement
  // yields the same instant. Cast to UTC explicitly because Drizzle reads
  // `timestamp without time zone` back as UTC, while a bare now() would be
  // rendered using the session's TimeZone.
  const nowUtc = sql`(now() at time zone 'utc')`;
  const refilled = sql`least(${capacity}, ${rateLimitBuckets}."tokens" + extract(epoch from (${nowUtc} - ${rateLimitBuckets}."updatedAt")) * ${refill})`;

  const consumed = await db.execute<{ tokens: number }>(sql`
    insert into ${rateLimitBuckets} ("key", "tokens", "updatedAt")
    values (${key}, ${capacity} - 1, ${nowUtc})
    on conflict ("key") do update
       set "tokens" = ${refilled} - 1,
           "updatedAt" = ${nowUtc}
     where ${refilled} >= 1
    returning "tokens"
  `);

  if (consumed.rows.length > 0) {
    return { allowed: true, remaining: Math.floor(Number(consumed.rows[0].tokens)) };
  }

  // Denied. A second read only to tell the caller how long to wait; it runs on
  // the rejection path, which is the path that is supposed to be cheap for the
  // server and slow for the caller.
  const state = await db.execute<{ tokens: number; seconds_since: number }>(sql`
    select "tokens", extract(epoch from (${nowUtc} - "updatedAt")) as seconds_since
      from ${rateLimitBuckets}
     where "key" = ${key}
  `);

  const row = state.rows[0];
  return {
    allowed: false,
    retryAfterSeconds: row
      ? retryAfterSeconds(policy, Number(row.tokens), Number(row.seconds_since))
      : 1,
  };
}

/** The 429 every limited route returns, so the shape stays identical. */
export function tooManyRequests(result: { retryAfterSeconds: number }, message: string): Response {
  return Response.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    }
  );
}
