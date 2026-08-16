import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

/**
 * Everything that runs without a database: pure logic, the stream parsers, and
 * the guest path of the API route (which touches neither auth nor Postgres).
 *
 * The `name` is load-bearing. Vitest keys projects by name, and an earlier
 * revision left both this project and the db project unnamed with identical
 * `include` globs — the two collapsed into one and the db suite silently never
 * ran. Naming them, and making the globs disjoint, is what keeps that honest.
 */
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "unit",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      // Owned by the `db` and `perf` projects — both need a live Postgres.
      "src/**/*.db.test.{ts,tsx}",
      "src/**/*.perf.test.{ts,tsx}",
      "src/lib/db/migrations/**",
    ],
  },
});
