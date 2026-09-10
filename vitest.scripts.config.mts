import { defineConfig } from "vitest/config";

/**
 * Standalone suite for scripts/, run via `npm run test:scripts` in the CI
 * `quality` job (Plan 6) rather than as a project inside `npm test` — same
 * reasoning as vitest.eval.config.mts and vitest.perf.config.mts: it's not
 * part of the coverage-gated suite, and nothing outside src/ is visible to
 * the default configs.
 */
export default defineConfig({
  test: {
    name: "scripts",
    environment: "node",
    include: ["scripts/**/*.test.mts"],
  },
});
