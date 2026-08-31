import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The eval suite (docs/plans/v3/01-llm-eval-harness.md), run standalone via
 * `npm run eval` rather than as a project inside `npm test`, for the same
 * reason the perf suite is standalone: it manages its own mock-server
 * lifecycle, and in its live form (npm run eval:live) it spends real money.
 * It must never be added to the `projects` array in vitest.config.mts.
 *
 * The include globs cover evals spec files (the Layer 1/2 eval specs plus pure
 * unit tests for the harness itself) and the mock-provider specs under
 * test-support, so those wire-shape specs have somewhere to run — nothing
 * outside src is visible to the default test configs, so this suite is where
 * they live.
 *
 * `pool: "forks"` gives each test file a fresh process: adapter clients are
 * memoized after their first use, and each eval file points the base-URL env
 * seam at its own mock server in beforeAll before any generation runs.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "eval",
    environment: "node",
    include: ["evals/**/*.test.ts", "test-support/**/*.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
