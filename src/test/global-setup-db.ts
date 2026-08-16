import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432";

/**
 * Builds the "fabula_test_template" database that setup-db.ts clones per worker.
 * Runs the real migrations in src/lib/db/migrations rather than pushing schema.ts,
 * so the suite exercises the same SQL that ships to production.
 */
export async function setup() {
  const admin = new Pool({ connectionString: `${BASE}/postgres` });
  // WITH (FORCE): a previous crashed run can leave a connection attached, and
  // CREATE DATABASE ... TEMPLATE refuses to copy a template anyone is connected to.
  await admin.query(`DROP DATABASE IF EXISTS "fabula_test_template" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "fabula_test_template"`);
  await admin.end();

  const templatePool = new Pool({ connectionString: `${BASE}/fabula_test_template` });
  await migrate(drizzle({ client: templatePool }), {
    migrationsFolder: "./src/lib/db/migrations",
  });
  // Must close before any worker clones this database, for the same reason the
  // FORCE above exists.
  await templatePool.end();
}
