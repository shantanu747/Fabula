import { Redis } from "@upstash/redis";

/**
 * The Redis handle. `@upstash/redis` — REST-based, so there is no TCP connection
 * pool to manage on serverless and it works in the Edge runtime (where
 * `proxy.ts` runs). Same reasoning that put `neon-http` in `src/lib/db/client.ts`.
 *
 * Constructed lazily, not at module scope, for the same reason as `getDb()`:
 * a contributor who clones the repo without provisioning Redis must still be
 * able to run `next build`/`next dev` and use the guest flow.
 */
let kv: Redis | undefined;

function createKv(): Redis {
  // Local-development / CI escape hatch: `serverless-redis-http` in front of a
  // plain Redis speaks the same REST protocol Upstash does, so the production
  // client works unmodified against it — same shape as NEON_FETCH_ENDPOINT for
  // the database driver (docs/plans/v4/README.md, docs/adr/0035).
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

export function getKv(): Redis {
  if (!kv) kv = createKv();
  return kv;
}

/**
 * Whether Redis is configured at all.
 *
 * Redis is never authoritative (docs/adr/0035) — every caller of getKv() must
 * have already decided what to do when this is false, and it must never be
 * "throw". This mirrors `hasDatabase()`'s reasoning for the same audience: a
 * contributor who clones the repo and never provisions Redis still gets a
 * working (Postgres-limited, unbounded-admission, unbounded-budget) app.
 */
export function hasKv(): boolean {
  return kv !== undefined || Boolean(process.env.KV_REST_API_URL);
}

/**
 * Test-only seam, mirroring `__setDbForTests`. Guarded rather than
 * conditionally compiled so misuse fails loudly in production instead of
 * silently swapping the backend.
 */
export function __setKvForTests(next: Redis | undefined): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setKvForTests must never be called in production");
  }
  kv = next;
}

/**
 * A hung Redis call must never add latency in front of TTFT (docs/adr/0035) —
 * that would turn the cost optimisation into a latency regression. Every
 * caller wraps its Redis operation(s) in this rather than calling the client
 * directly, so there is exactly one place the timeout budget is decided.
 *
 * Resolves to `undefined` on timeout or on any thrown error — indistinguishable
 * to the caller, which is deliberate: "Redis didn't answer in time" and "Redis
 * threw" get the same fallback treatment everywhere this is used.
 */
export async function withKvTimeout<T>(op: () => Promise<T>, timeoutMs = 250): Promise<T | undefined> {
  try {
    return await Promise.race([
      op(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  } catch {
    return undefined;
  }
}
