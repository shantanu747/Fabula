import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { TEST_DB_BASE_URL, TEMPLATE_DB_NAME } from "./db-names";

/**
 * Builds the template database every worker is cloned from, once per run.
 *
 * The template is built by running the migrations in src/lib/db/migrations,
 * not by pushing schema.ts. That difference matters: it means the suite tests
 * the SQL that will actually be applied to production, so a migration that is
 * missing from meta/_journal.json, or that fails against existing rows, fails
 * here instead of on deploy. (Both of those have already happened once.)
 */
export async function setup() {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });

  try {
    await admin.query("SELECT 1");
  } catch (err) {
    await admin.end().catch(() => {});
    throw new Error(
      `Cannot reach Postgres at ${TEST_DB_BASE_URL}. The db suite needs a real ` +
        `database — start one with:\n\n` +
        `  docker run -d --name fabula-test-pg -e POSTGRES_PASSWORD=postgres \\\n` +
        `    -e POSTGRES_USER=postgres -p 5432:5432 postgres:17-alpine\n\n` +
        `or point TEST_DATABASE_URL at your own. Original error: ${(err as Error).message}`
    );
  }

  // WITH (FORCE) rather than a plain DROP: a previous crashed run can leave a
  // connection attached, and CREATE DATABASE ... TEMPLATE refuses to copy a
  // template that anyone is connected to.
  await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  await admin.end();

  const templatePool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${TEMPLATE_DB_NAME}` });
  await migrate(drizzle({ client: templatePool }), {
    migrationsFolder: "./src/lib/db/migrations",
  });
  // Must close before any worker clones this database, for the same reason the
  // FORCE above exists.
  await templatePool.end();
}

export async function teardown() {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE 'fabula_test_%'`
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
  await admin.end();
}
