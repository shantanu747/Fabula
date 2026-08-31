import { Pool } from "pg";
import { TEST_DB_BASE_URL } from "../../src/test/db-names";
import { E2E_DB_NAME } from "../constants";

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
}
