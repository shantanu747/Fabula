import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { __setDbForTests } from "@/lib/db/client";
import type { AppDatabase } from "@/lib/db/types";
import * as schema from "@/lib/db/schema";
import { TEST_DB_BASE_URL, TEMPLATE_DB_NAME, workerDbName } from "./db-names";

// The one module mock in the suite. See src/test/session.ts for why.
vi.mock("@/auth", async () => {
  const { getTestSession } = await import("./session");
  return {
    auth: async () => getTestSession(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  };
});

const dbName = workerDbName();

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  // Cloning the migrated template costs one file copy; re-running the migrations
  // per worker would cost a full DDL replay.
  await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`);
  await admin.end();

  // max >= 4 because the concurrency specs need genuinely simultaneous
  // connections: the whole point is one statement blocking on another's
  // uncommitted index entry, which cannot happen if they share a connection.
  pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${dbName}`, max: 8 });

  // The only place NodePgDatabase meets AppDatabase. The surfaces the app uses
  // (select/insert/update/delete/execute, .rows/.rowCount) are identical; the
  // types differ only in the result HKT. AppDatabase omits `transaction` and
  // `batch` precisely so no app code can reach a surface where the two drivers
  // disagree, which is what makes this cast safe rather than wishful.
  __setDbForTests(drizzle({ client: pool, schema }) as unknown as AppDatabase);
});

let truncateStatement: string | undefined;

beforeEach(async () => {
  // Discovered rather than hand-listed: a hard-coded list silently rots the
  // moment a migration adds a table, and the failure surfaces as a confusing
  // cross-test data leak rather than as a missing name. Drizzle's own bookkeeping
  // table lives in the `drizzle` schema, so restricting to `public` spares it —
  // wiping it would make the clone look unmigrated.
  if (!truncateStatement) {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    truncateStatement = `TRUNCATE ${rows
      .map((r) => `"${r.tablename}"`)
      .join(",")} RESTART IDENTITY CASCADE`;
  }
  await pool.query(truncateStatement);
});

afterAll(async () => {
  __setDbForTests(undefined);
  await pool?.end();
});

/** For specs that need a second, independent connection (the race tests). */
export function testPool(): Pool {
  return pool;
}
