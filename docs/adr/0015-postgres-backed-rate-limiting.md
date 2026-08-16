# 15. Postgres-backed rate limiting

## Status

Accepted.

## Context

`/api/generate` was unauthenticated, unthrottled, and spends money on every call. `MAX_OUTPUT_TOKENS` caps the size of one generation, not the number of them, so a loop against the deployed endpoint drains the operator's provider balance at whatever rate the network allows. `docs/PRD.md` names cost control as a v1 risk and `docs/adr/0011` states plainly that rate limiting "remains the honest next step". This is that step.

`/api/auth/register` has the same shape of exposure for a different reason. `docs/adr/0011` closed the response and timing enumeration channels there and noted that an attacker with unlimited attempts retains other avenues. Each attempt also costs a bcrypt hash at cost factor 12, which is deliberately expensive.

The constraint that shapes everything here is that the app runs on serverless functions. The obvious implementation, a `Map` in module scope, does not limit a caller: it limits one instance. Requests spread across instances get a fresh budget each, and every counter resets whenever the platform recycles the isolate. It fails in the direction that matters, silently, and only under the load that makes it necessary.

## Decision

**A token bucket, held in Postgres.** A row per caller in `rate_limit_bucket`, keyed by identity, holding a fractional token count and the time it was last touched. Tokens accrue continuously from elapsed time and are capped at the bucket's capacity.

A token bucket rather than a fixed window because a window has a boundary, and a boundary is exploitable: a caller spends a full budget at the end of one window and another at the start of the next, achieving twice the intended rate at exactly the moment they are trying hardest. It also gives a natural burst allowance, which matters here because writing a story is bursty and a person composing a paragraph will never approach the sustained rate.

Postgres rather than Redis because the database is already a dependency of every request being protected, and one more managed service is real operational weight (another account, another failure mode, another secret) for a counter. The bucket read is a primary-key lookup. If contention ever makes that the wrong trade, moving to Upstash is a change to one file.

**The whole operation is one statement.** Refill, check, and decrement happen inside a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, with the denial expressed as the statement returning no rows.

This is not stylistic. Reading the bucket and then writing it back is the identical TOCTOU to the paragraph-position race in `docs/adr/0013`: every concurrent caller reads "four tokens left" before any of them writes, and they all proceed. As one statement, Postgres serialises conflicting upserts on the primary key, so the second waits for the first to commit and then re-evaluates its `WHERE` against the row the first actually wrote. The driver forces the same conclusion independently, since neon-http offers no transaction, no session, and no advisory lock to reach for.

**Identity is the account when there is one, and the address otherwise.** `auth()` is now resolved for every generation request rather than only persisted ones; with JWT sessions this verifies a cookie and makes no database call. Keying a signed-in Writer by address instead would put a household behind one connection on a single shared budget, and a parent and child co-writing on a tablet is the exact pair `docs/PRD.md` describes.

Addresses are hashed into the key. The table is a counter, and it should not also be a log of which addresses used the app and when.

**Limits.** Guests get a burst of 5 and a token every 30 seconds. Signed-in Writers get 20 and a token every 15. Registration gets 5 and a token a minute. These are set so that a person writing a story never meets them and a script meets them immediately; they are constants in `src/lib/ratelimit/policy.ts` and are meant to be tuned once real traffic exists.

**The limiter fails closed.** If the bucket query errors, the request is denied with a 429. Failing open would hand the entire provider budget to anyone able to make the database unhappy, which inverts the purpose of the control.

**No database configured means no limiting, loudly.** `hasDatabase()` reports whether a handle exists. Without one the limiter logs a warning and allows the request, so that guest writing still works for someone who has cloned the repo without provisioning Postgres. Guest use has never required a database (`docs/adr/0009`) and this should not quietly make it a hard requirement.

**The check sits after validation and the turn check.** A malformed or out-of-turn request never reaches a provider and costs nothing, so spending a token on one would only punish a buggy client.

## Consequences

- A deployed Fabula can no longer have its provider balance drained by an anonymous loop. This was the most serious open exposure in the app.
- A database outage now stops generation for guests, who were previously unaffected by one. This is the accepted cost of failing closed, and it is the tradeoff most worth revisiting if it ever bites: bounded spend was judged the more important property.
- Every generation resolves `auth()`, including guest requests that previously touched no auth at all. With JWT sessions this is a signature verification and no round trip.
- Reading the leftmost `x-forwarded-for` entry is correct behind a proxy that rewrites the header, which is the case on Vercel. Behind an ingress that merely appends, a caller could spoof it and mint fresh buckets; that deployment must count back from the right instead. Signed-in Writers are unaffected either way. The assumption is documented at the function.
- Buckets accumulate one row per caller and nothing prunes them. At this scale it does not matter; a periodic delete of rows untouched for a day is the obvious follow-up.
- A 429 is a new response from `/api/generate`. `GenerationErrorKind` gained a `rate-limited` member, and the UI suppresses its retry button for it, since retrying immediately can only fail again.
