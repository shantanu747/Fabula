import { sql } from "drizzle-orm";
import { rateLimitBuckets } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";
import { bucketKey, retryAfterSeconds, type RateLimitPolicy } from "./policy";

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Refill, check, and decrement as one atomic step — the Lua-script equivalent
 * of store.ts's Postgres upsert, and atomic for the same reason: a Redis
 * script runs to completion without another command interleaving, so the
 * whole read-modify-write happens in a place nothing else can observe halfway
 * through. `HMGET` on a key that has never been written returns `false` for
 * every field, which is how a bucket starts full rather than needing a
 * separate "does this key exist" branch.
 *
 * Returns `{ allowed, tokens (post-op remaining, or current on denial),
 * elapsedSeconds }` — the same three numbers store.ts's Postgres path
 * produces, so both backends can be reduced to a RateLimitResult by the same
 * `retryAfterSeconds` helper (docs/adr/0035's parity discipline).
 */
const BUCKET_SCRIPT = `
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local updatedAt = tonumber(redis.call('HGET', KEYS[1], 'updatedAt'))
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

if tokens == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = math.max(0, (now - updatedAt) / 1000)
local refilled = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local resultTokens = refilled
if refilled >= 1 then
  allowed = 1
  resultTokens = refilled - 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(resultTokens), 'updatedAt', tostring(now))
-- Time to fully refill from empty, plus margin: an idle bucket expires instead
-- of persisting forever. Postgres has the same idle-row problem, which is why
-- it needs the cron prune job; Redis just lets the key die on its own.
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / refill) + 60)

return {allowed, tostring(resultTokens), tostring(elapsed)}
`;

async function consumeTokenKv(
  policy: RateLimitPolicy,
  identity: string
): Promise<RateLimitResult | undefined> {
  return withKvTimeout(async () => {
    const key = bucketKey(policy, identity);
    const now = Date.now();
    const [allowed, tokens, elapsed] = await getKv().eval<string[], [number, string, string]>(
      BUCKET_SCRIPT,
      [key],
      [String(policy.capacity), String(policy.refillPerSecond), String(now)]
    );
    if (allowed === 1) {
      return { allowed: true, remaining: Math.floor(Number(tokens)) };
    }
    return {
      allowed: false,
      retryAfterSeconds: retryAfterSeconds(policy, Number(tokens), Number(elapsed)),
    };
  });
}

/**
 * Takes one token from a caller's bucket, refilling it for elapsed time first.
 *
 * Redis first when configured, Postgres always as the fallback — never the
 * other way around, and never a hard dependency on Redis (docs/adr/0035:
 * Redis is never authoritative). `consumeTokenKv` already collapses "Redis
 * absent", "timed out", and "threw" into the same `undefined`, so the only
 * thing this function decides is which backend answered; `guard.ts` cannot
 * tell the difference.
 *
 * The Postgres path's own correctness argument:
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
  if (hasKv()) {
    const kvResult = await consumeTokenKv(policy, identity);
    if (kvResult) return kvResult;
  }
  return consumeTokenPostgres(db, policy, identity);
}

async function consumeTokenPostgres(
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
