import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone suite for scripts/ and bench/, run via `npm run test:scripts` in
 * the CI `quality` job (Plan 6) rather than as a project inside `npm test` —
 * same reasoning as vitest.eval.config.mts and vitest.perf.config.mts: it's not
 * part of the coverage-gated suite, and nothing outside src/ is visible to
 * the default configs.
 *
 * bench/report.ts is pure (no I/O, no timers — see docs/plans/v4/01-load-harness.md),
 * so bench/report.test.ts runs here rather than needing a database. It excludes
 * `*.db.test.ts` the same way vitest.unit.config.mts does: bench/roundtrips.db.test.ts
 * needs a real Postgres and belongs to vitest.db.config.mts's project instead —
 * ADR 0014 records what happens when two projects' globs overlap (one silently
 * never runs), so the two stay disjoint by filename, not by directory alone.
 *
 * The `@` alias (matching vitest.unit.config.mts/vitest.db.config.mts) is
 * needed as of docs/adr/00NN: db/tracing.ts's *value* import of
 * requestContext.ts (not the type-only `@/lib/db/types` imports this
 * project's scripts already had, which esbuild strips entirely, needing no
 * runtime resolution) pulls a real `@/`-aliased module in transitively from
 * scripts/slo-report.mts's own import of generationEvents.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "scripts",
    environment: "node",
    include: ["scripts/**/*.test.mts", "bench/**/*.test.ts"],
    exclude: ["bench/**/*.db.test.ts"],
  },
});
