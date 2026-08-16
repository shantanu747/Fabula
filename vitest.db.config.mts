import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

/**
 * Specs that need a real Postgres: the paragraph-position concurrency work and
 * the rate limiter, both of which are enforced by the database rather than by
 * application logic and so cannot be proven against a fake.
 *
 * Requires TEST_DATABASE_URL (or a Postgres on localhost:5432). `npm run test:db`
 * runs it; `npm test` runs it too, and fails loudly if no database is reachable
 * rather than reporting green on a suite that never executed.
 */
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.db.test.{ts,tsx}"],
    globalSetup: ["./src/test/global-setup-db.ts"],
    setupFiles: ["./src/test/setup-db.ts"],
    // Database-per-worker keyed on VITEST_POOL_ID. `forks` gives each worker a
    // stable id for the lifetime of the run, which is what makes that safe.
    pool: "forks",
  },
});
