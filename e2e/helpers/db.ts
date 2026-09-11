import { Pool } from "pg";
import { Redis } from "@upstash/redis";
import { TEST_DB_BASE_URL } from "../../src/test/db-names";
import { E2E_DB_NAME, KV_REST_API_TOKEN, KV_REST_API_URL } from "../constants";

/**
 * Raw node-postgres, not the app's Neon-proxy connection — same reasoning as
 * src/test/: truncating is faster and simpler direct against the real driver,
 * and it needs to work independently of whatever the app's own connection is
 * doing. One pool for the whole worker process (workers: 1, so this is really
 * one pool for the whole run).
 */
const pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${E2E_DB_NAME}` });

/**
 * Truncates everything a spec could have written, called in every spec's
 * beforeEach. `rate_limit_bucket` is the one people forget: the rate-limit spec
 * exhausts the guest bucket for the loopback address (every guest request in
 * this suite shares one identity — see src/lib/ratelimit/policy.ts's clientIp(),
 * which falls back to "unknown" with no proxy headers in front of Playwright),
 * and every later spec would silently 429 without this.
 */
export async function resetDatabase(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE "story_report", "story_paragraph", "story", "rate_limit_bucket", "session", "account", "user" CASCADE`
  );

  // The same trap, in Redis (docs/adr/0035): admission/budget/rate-limit state
  // isn't touched by the TRUNCATE above at all. A global FLUSHALL — unlike the
  // per-worker-database Postgres truncate — is only safe because this suite
  // runs with `workers: 1` (playwright.config.ts); it would corrupt another
  // worker's in-progress state under real parallelism, which is exactly why
  // the Vitest `db` project (multiple forked workers) does *not* do this — see
  // src/test/setup-db.ts's comment. global-setup.ts's verifyRedisReachable()
  // already fails the whole run loudly if this isn't reachable, so this call
  // is expected to succeed whenever the suite gets this far.
  await new Redis({ url: KV_REST_API_URL, token: KV_REST_API_TOKEN }).flushall();
}
