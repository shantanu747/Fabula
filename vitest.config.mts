import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.unit.config.mts";
import dbConfig from "./vitest.db.config.mts";

export default defineConfig({
  test: {
    // The perf project is intentionally absent — see vitest.perf.config.mts.
    projects: [unitConfig, dbConfig],

    // Coverage belongs to the root config. Vitest ignores a `coverage` block
    // inside a project config, so the thresholds below only actually gate
    // anything from here.
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/app/api/**"],
      exclude: [
        "src/lib/db/migrations/**",
        // Exercised through the UI, not through this suite. Covering it would
        // mean a jsdom/React-testing-library dependency for one file's worth of
        // reducer glue; the logic worth protecting (turn policy, validation,
        // stream parsing) already lives in covered modules.
        "src/lib/story/StoryContext.tsx",
        // Thin SDK adapters. Each is a few lines mapping a vendor stream to
        // text chunks, and testing them means either mocking the SDK internals
        // (asserting the mock, not the code) or spending real tokens in CI. The
        // shared logic they delegate to — prompt building, windowing, metadata
        // extraction — is covered directly.
        "src/lib/providers/{anthropic,openai,openrouter}.ts",
        // Declarative table definitions. What executes in it are the id
        // `$defaultFn` closures, which only run when the suite happens to insert
        // through Drizzle into that particular table, so the percentage measures
        // which tables the specs touch rather than whether the schema is right.
        // The schema is checked where it matters instead: the db suite builds
        // itself by running the migrations, and queries.perf.test.ts asserts the
        // indexes are the ones the planner picks.
        "src/lib/db/schema.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        // Tiered, not a flat global number. The tiers say where a regression is
        // actually expensive: the shared libraries hold the subtle code, so they
        // are held at 100%, while the route handlers include provider/network
        // error paths that cost more to reach than they are worth.
        "src/lib/story/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/lib/providers/{prompt,registry,list,constants,types,pricing}.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/lib/db/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/lib/ratelimit/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // logger.ts's redaction allowlist and requestId.ts's header validation are
        // both structural safety guarantees (never log story text; never echo an
        // unvalidated header into a log line) rather than ordinary route glue, so
        // this sits at the same tier as the other safety-critical libraries above.
        "src/lib/observability/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/app/api/generate/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/app/api/health/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
