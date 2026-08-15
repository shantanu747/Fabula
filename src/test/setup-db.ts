import { beforeAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { __setDbForTests } from "../src/lib/db/client";
import type { AppDatabase } from "../src/lib/db/types";
import * as schema from "../src/lib/db/schema";

// Mock the auth module for tests
import { vi } from "vitest";
export let currentSession: any = null;
vi.mock("@/auth", () => ({
  auth: async () => currentSession, handlers: {}, signIn: vi.fn(), signOut: vi.fn(),
}));

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432";
const dbName = `fabula_test_${process.env.VITEST_POOL_ID ?? "1"}`;

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: `${BASE}/postgres` });
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "fabula_test_template"`);
  await admin.end();

  // max >= 4: the concurrency specs need genuinely simultaneous connections.
  pool = new Pool({ connectionString: `${BASE}/${dbName}`, max: 8 });
  // The ONLY place NodePgDatabase meets AppDatabase. The surfaces the app uses
  // (select/insert/update/delete/execute, .rows/.rowCount) are identical; the
  // types differ only in the result HKT. The neon-http conformance job re-runs
  // these specs on the real driver, which is what makes this cast safe.
  __setDbForTests(drizzle({ client: pool, schema }) as unknown as AppDatabase);
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE "story_paragraph","story_report","story","session","account","user" RESTART IDENTITY CASCADE`
  );
});

// Export pool for use in tests
export { pool };