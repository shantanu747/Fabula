import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The EXPLAIN suite, run standalone via `npm run test:perf` rather than as a
 * project inside `npm test`. It seeds six figures of rows, which is far too
 * slow for the default run and would tempt everyone into skipping the whole
 * suite. Run it when touching an index or a hot-path query.
 *
 * These specs assert on plan *shape* — Index Scan chosen, no Sort node — never
 * on wall clock. Timing assertions on a shared CI runner are the classic flake,
 * and they also fail to catch the thing that actually matters: a query silently
 * reverting to a sequential scan while staying fast on a small table.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "perf",
    environment: "node",
    include: ["src/**/*.perf.test.{ts,tsx}"],
    globalSetup: ["./src/test/global-setup-db.ts"],
    setupFiles: ["./src/test/setup-perf.ts"],
    pool: "forks",
    // One worker: the seed is expensive and every spec in the file shares it.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
