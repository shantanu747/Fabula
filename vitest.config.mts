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
        // A three-line re-export of Auth.js's own request handlers — every
        // other test in this suite mocks `@/auth` entirely (src/test/session.ts),
        // and there is no meaningful behavior here of this app's own to assert
        // on separately from that mock.
        "src/app/api/auth/[...nextauth]/route.ts",
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
        // New in v4 Plan 2 (docs/adr/0035, docs/adr/0036): the Redis tier and
        // its two consumers. Same tier as ratelimit/** — a regression here is
        // exactly the "subtle code where a mistake is expensive" this
        // comment already describes: a wrong fail-open/fail-closed branch is
        // either an unbounded bill (budget) or every Writer refused (admission).
        "src/lib/kv/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/lib/admission/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/lib/budget/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // New in v4 Plan 5 (docs/adr/0045-provider-circuit-breaker.md): same
        // tier as admission/budget above — a wrong fail-open/fail-closed
        // branch here is either a permanently-tripped breaker refusing a
        // healthy provider, or a broken probe-claim letting an unbounded
        // thundering herd through on every cooldown tick.
        "src/lib/providers/circuitBreaker.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // New in v4 Plan 4 (docs/adr/0042, docs/adr/0043): the framed wire
        // protocol and the resume buffer. Same tier as kv/admission/budget —
        // protocol.ts is pure and easy to hold at 100% (the plan's own
        // instruction), and resumeBuffer.ts is exactly the "subtle,
        // expensive-to-get-wrong" shape (a wrong cap/TTL/identity-check is
        // either unbounded storage or a cross-account data leak) those three
        // are already held to.
        "src/lib/streaming/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Small pure helpers with no side effects and few enough branches
        // (stageIndex's four boundaries chief among them) that partial coverage
        // would just mean an untested boundary, not a cost/benefit tradeoff.
        "src/lib/ui/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // logger.ts's redaction allowlist and requestId.ts's header validation are
        // both structural safety guarantees (never log story text; never echo an
        // unvalidated header into a log line) rather than ordinary route glue, so
        // this sits at the same tier as the other safety-critical libraries above.
        "src/lib/observability/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // New in v4 Plan 6 (docs/adr/0046, docs/adr/0047): token issuance,
        // hashing, single-use consumption, and session-version comparison —
        // the same "a wrong branch is a real vulnerability" shape as
        // ratelimit/kv/admission above (a bug here is token reuse, a
        // revocation bypass, or the wrong account getting a reset), so the
        // same 100% tier.
        "src/lib/auth/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // The Mailer abstraction (docs/adr/0046) — small and easy to hold at
        // 100%; the registry/console modules are pure selection and logging,
        // and resend.ts's one branch (the failed-fetch path) is cheap to
        // exercise with a mocked fetch.
        "src/lib/email/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // The CSRF origin guard (docs/adr/0048) is a structural security
        // control in the same sense as the auth-token modules above — a
        // missed branch here is a forgeable mutating route, not a cosmetic
        // bug. csp.ts already happened to sit at 100% before this tier
        // existed; this makes that a held guarantee rather than an accident.
        "src/lib/security/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // readJsonBody.ts's three branches (oversized, unreadable, invalid
        // JSON) are exactly the kind of small-and-cheap-to-fully-cover
        // helper src/lib/ui/** already sits at 100% for.
        "src/lib/http/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/app/api/generate/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/app/api/health/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/app/api/auth/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
