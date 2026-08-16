import { afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { __setDbForTests } from "@/lib/db/client";
import type { AppDatabase } from "@/lib/db/types";
import * as schema from "@/lib/db/schema";
import { TEST_DB_BASE_URL, TEMPLATE_DB_NAME, workerDbName } from "./db-names";

/**
 * Like setup-db, minus the per-test TRUNCATE. The perf suite seeds a large
 * dataset once and every spec reads it — truncating between specs would either
 * throw the seed away or force it to be rebuilt per assertion.
 */

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  await admin.query(`DROP DATABASE IF EXISTS "${workerDbName()}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${workerDbName()}" TEMPLATE "${TEMPLATE_DB_NAME}"`);
  await admin.end();

  pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${workerDbName()}`, max: 4 });
  __setDbForTests(drizzle({ client: pool, schema }) as unknown as AppDatabase);
});

afterAll(async () => {
  __setDbForTests(undefined);
  await pool?.end();
});

export function perfPool(): Pool {
  return pool;
}
