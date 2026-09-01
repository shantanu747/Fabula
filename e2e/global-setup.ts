import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { TEST_DB_BASE_URL } from "../src/test/db-names";
import { startMockProvider } from "../test-support/mock-provider/server";
import { E2E_DB_NAME, MOCK_PROVIDER_PORT, NEON_FETCH_ENDPOINT } from "./constants";

/**
 * Runs once, in the Playwright root process, before the app's `webServer`
 * starts (the app reads ANTHROPIC_BASE_URL and DATABASE_URL once at startup,
 * so both have to be live before that process boots). global-teardown.ts runs
 * in the same root process afterwards — see the globalThis handoff below.
 */
export default async function globalSetup() {
  await createAndMigrateDatabase();
  await verifyNeonProxyReachable();
  await startMock();
}

async function createAndMigrateDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  try {
    await admin.query("SELECT 1");
  } catch (err) {
    await admin.end().catch(() => {});
    throw new Error(
      `e2e/global-setup: cannot reach Postgres at ${TEST_DB_BASE_URL}. Start one with:\n\n` +
        `  docker run -d --name fabula-test-pg -e POSTGRES_PASSWORD=postgres \\\n` +
        `    -e POSTGRES_USER=postgres -p 5432:5432 postgres:17-alpine\n\n` +
        `or point TEST_DATABASE_URL at your own. Original error: ${(err as Error).message}`
    );
  }

  // WITH (FORCE) rather than a plain DROP, same reasoning as src/test/global-setup-db.ts:
  // a previous crashed run can leave a connection attached.
  await admin.query(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${E2E_DB_NAME}"`);
  await admin.end();

  const appPool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${E2E_DB_NAME}` });
  await migrate(drizzle({ client: appPool }), { migrationsFolder: "./src/lib/db/migrations" });

  // The Neon proxy's own start.sh bootstraps this table in the target database
  // once, at container startup — but startup almost certainly ran before this
  // database existed (or before this run's fresh DROP/CREATE above wiped it
  // out), so the proxy's one-time init is stale by the time it matters. Redone
  // here, every run, against the database that actually exists now. Without
  // it every proxied query 500s with "Control plane request failed: relation
  // neon_control_plane.endpoints does not exist" — this is the proxy's own
  // mock-auth bookkeeping, not application schema, so it isn't a Drizzle
  // migration.
  await appPool.query(`CREATE SCHEMA IF NOT EXISTS neon_control_plane`);
  await appPool.query(
    `CREATE TABLE IF NOT EXISTS neon_control_plane.endpoints (endpoint_id VARCHAR(255) PRIMARY KEY, allowed_ips VARCHAR(255))`
  );

  await appPool.end();
}

async function verifyNeonProxyReachable(): Promise<void> {
  try {
    // Any HTTP response (including a 4xx for a malformed body) means the proxy
    // is up and forwarding to Postgres; only a connection failure is fatal here.
    await fetch(NEON_FETCH_ENDPOINT, { method: "POST", body: "{}" });
  } catch (err) {
    throw new Error(
      `e2e/global-setup: cannot reach the Neon HTTP proxy at ${NEON_FETCH_ENDPOINT}. Start it with:\n\n` +
        `  docker run -d --name fabula-e2e-neon-proxy -p 4444:4444 \\\n` +
        `    -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/${E2E_DB_NAME}" \\\n` +
        `    ghcr.io/timowilhelm/local-neon-http-proxy:main\n\n` +
        `Original error: ${(err as Error).message}`
    );
  }
}

async function startMock(): Promise<void> {
  const mock = await startMockProvider({ port: MOCK_PROVIDER_PORT, remoteControl: true });
  // global-teardown.ts runs in this same root process (Playwright's documented
  // guarantee for globalSetup/globalTeardown) but is a separate module with no
  // direct reference to `mock` — globalThis is the handoff. Left open here would
  // otherwise keep the root process's event loop alive indefinitely.
  (globalThis as { __fabulaMockProvider?: Awaited<ReturnType<typeof startMockProvider>> }).__fabulaMockProvider =
    mock;
}
