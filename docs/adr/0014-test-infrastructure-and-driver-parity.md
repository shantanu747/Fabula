# 14. Test infrastructure and driver parity

## Status

Accepted.

## Context

The suite before this change was 164 lines across two files, both testing pure validation predicates. The stream parsers, the turn policy, the persistence reconciliation, and the route handler had no coverage at all. The subtle code was untested and the obvious code was tested twice.

Three things made the missing tests harder to write than they look.

The first is the database driver. Production runs `drizzle-orm/neon-http`, which sends one statement per HTTP request with no session state and no transactions (`docs/adr/0013`). It also speaks Neon's HTTP protocol rather than the Postgres wire protocol, so it cannot connect to a local Postgres at all. A test suite therefore has to run on `node-postgres`, and every difference between the two drivers becomes a way for a green test to ship a 500.

The second is that the interesting behaviour is concurrent. "Two turns race and one loses" is not a property of a function; it is a property of what Postgres does with two conflicting writes. A fake database can only ever confirm that the fake behaves like the fake.

The third is `auth`. It is a destructured NextAuth binding used at nine call sites, constructed at module scope, with no injection point.

An earlier attempt at this infrastructure had a defect worth recording, because it is the failure mode this whole area invites: two Vitest projects were defined with identical `include` globs and no `name`. They collapsed into one, the database project never ran, and nothing failed. The suite reported green while `pg` was not even installed and the template database it referenced did not exist. A test suite that cannot run is indistinguishable from one that passes, unless you go looking.

## Decision

**Three projects, disjoint by filename.** `*.test.ts` runs in the `unit` project with no database. `*.db.test.ts` runs in `db` against a real Postgres. `*.perf.test.ts` runs in `perf`, standalone via `npm run test:perf`, because it seeds six figures of rows. Each project is named, and the globs cannot overlap, so a project silently ceasing to run is not a state the configuration can reach.

**Seams over mocks, with one stated exception.** The database is injected through `__setDbForTests`, guarded to throw in production. Providers are injected by assigning into the exported `PROVIDERS` registry, which `getProvider` reads per call, so a fake provider needs no module machinery. `fetch` is replaced with a stub for the client-side stream specs. `auth` is the exception: a module mock, because there is no seam to use and adding one to production code to satisfy a test would be the worse trade. It is the only module mock in the suite, and `src/test/session.ts` holds the state it returns.

**`AppDatabase` omits `transaction` and `batch`.** The type is `Omit<NeonHttpDatabase, "transaction" | "batch">`. `transaction` exists on `NodePgDatabase` and throws at runtime on neon-http; `batch` is the mirror image, working in production and absent from the test driver. Omitting both means no application code can reach a surface where the two drivers disagree, which is what makes the `as unknown as AppDatabase` cast in the setup file safe rather than hopeful. ESLint bans both call shapes as well, and `driver-capabilities.test.ts` asserts that neon-http really does throw, so the reason for the omission is recorded as an executable fact rather than a comment.

**Database per worker, cloned from a migrated template.** A global setup builds `fabula_test_template` by running the migrations in `src/lib/db/migrations`, and each worker clones it. Running the migrations rather than pushing `schema.ts` means the suite tests the SQL that will actually be applied to production. This immediately earned itself: migration `0001` was absent from `meta/_journal.json` and would never have been applied to any real database, while every test of the constraint it adds passed against a schema pushed directly.

**Truncation between specs, not transaction rollback.** Each spec starts from a truncated database, with the table list discovered from `pg_tables` rather than hand-maintained. Transaction-rollback isolation was rejected outright: it requires the code under test to run inside a transaction the harness owns, which is precisely the divergence the `AppDatabase` type exists to prevent. Worse, two "concurrent" requests inside one transaction see each other's uncommitted rows and can never conflict, so the entire concurrency design would be untested while reporting green.

**Deterministic races through a proxy, asserting invariants rather than orderings.** `src/test/latch.ts` provides a barrier and a gate; a Proxy around the database handle suspends a request in the window between its read and its write. Specs then assert what must be true regardless of scheduling — exactly one writer wins, positions stay dense and unique — never which one won. A spec that pinned the winner would be asserting scheduler luck.

**Property-based tests where the input space is the point.** `fast-check` drives the two stream parsers with arbitrary chunk splits, including splits at byte boundaries that cut multi-byte characters in half. Both parsers deal with protocol boundaries inside a byte stream whose chunk boundaries fall wherever the provider's tokenizer put them, and enumerating those splits by hand only ever produces the ones already thought of.

**Local driver parity via `NEON_FETCH_ENDPOINT`.** `createDb` honours this variable so a developer can point the production driver at a local Neon HTTP proxy and run the real driver against a local database. Without it there is no way to exercise neon-http outside production.

## Consequences

- The suite runs 190 specs across three projects and requires a Postgres for two of them. `npm test` fails loudly when it cannot reach one, rather than skipping and reporting green.
- Writing these tests found five defects that all type-checked, linted, and built: the missing journal entry, a schema expression that broke `drizzle-kit generate` outright, a swallowed mid-stream provider error, a leading-newline leak in the metadata parser, and a greedy regex that let a blank `THEME:` swallow the next line. Two more came out of the EXPLAIN suite (`docs/adr/0016`, `docs/adr/0017`).
- Coverage thresholds are tiered by where a regression is expensive, not set to one global number. The shared story and provider libraries sit at 100%; the route handlers sit lower because their remaining branches are provider and network failure paths that cost more to reach than they are worth.
- The perf project is outside `npm test` on purpose. Nothing enforces that someone runs it after touching an index, which is a real gap; the alternative was a default test run slow enough that people skip all of it.
- `fast-check` and `pg` are new devDependencies. `playwright` is installed for responsive checks and is not wired into CI.
