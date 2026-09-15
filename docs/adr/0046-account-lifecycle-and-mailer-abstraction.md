# 46. Account lifecycle and the mailer abstraction

## Status

Accepted.

## Context

`docs/plans/v4/06-account-lifecycle.md`'s review of the accounts work (ADRs 0009, 0011) found:
`authorize()` has no rate limit of any kind; there is no email verification, despite
`users.emailVerified` and the `verificationToken` table already existing (added for
`@auth/drizzle-adapter`'s shape, never written to); there is no password reset; and there is no
Origin/CSRF check on the app's own mutating routes, `POST /api/stories/[id]/report` — which reads no
body at all — being the one genuinely forgeable today (see ADR 0048 for that half).

The email-verification gap is a real vulnerability, not a completeness gap: register an address you
don't own, and because `allowDangerousEmailAccountLinking` is (correctly) unset, the real owner's
later "Continue with Google" for that same address fails with `OAuthAccountNotLinked` — account
squatting that blocks the legitimate owner from ever using their own address on this app. Takeover in
the other direction was already closed by ADR 0011 (`onConflictDoNothing` on email, `authorize()`
returning null when `passwordHash` is absent).

Spec: `docs/plans/v4/06-account-lifecycle.md`.

## Decision

**Verification gates sharing, not writing.** This is the plan's central call, and the one worth
justifying: gating the core write flow would violate the US-6 resolution (theme/characters/lines,
and now an account itself, are never a prerequisite for the human "I'll write" path) and would leave
a signed-in-but-unverified Writer worse off than a logged-out guest, which guest writing's parity
guarantee (ADR 0009) forbids. Sharing is different in kind: it is the one action with a third-party
consequence (another Writer reads it in the feed, `docs/adr/0010`), so it is the action worth gating,
and gating it closes the squatting hole at exactly the point where squatting would otherwise pay
off — an attacker who can't share gains nothing by holding someone else's address. Enforced in
`PATCH /api/stories/[id]`, re-reading `session.user.verified` at request time, not only in
`ShareToggle`'s disabled rendering — the UI state is what makes the gate visible before a Writer hits
it, not the boundary itself. An unverified Writer's own un-share (`isShared: false`) is never gated;
only the transition to shared is.

**Google sign-ins are verified immediately from the provider's own `email_verified` claim**
(`src/lib/auth/googleAutoVerify.ts`'s `shouldAutoVerifyGoogleAccount`, wired into `signIn()` in
`src/auth.ts`). This is not spelled out by the plan, which frames the squatting fix entirely around
Credentials-vs-Credentials — but the gate above applies uniformly to every signed-in Writer, and a
Google account has no password-reset-shaped flow to verify through in the first place. Without this,
every Google-authenticated Writer would be permanently blocked from sharing, which is a product
regression nothing in the plan intends. Trusting Google's flag here is exactly the pattern Auth.js's
own docs suggest for this decision; only ever sets the flag (never clears it), and only for the
`google` provider — a Credentials sign-in is never routed through it.

**The existing `verificationToken` table is reused, not replaced**, for the same email-verification
flow it was already shaped for — `identifier` holds the address, `token` holds a SHA-256 hash of the
value emailed to the Writer, never the raw value. A new `password_reset_token` table (`tokenHash`
primary key, `userId`, `expires`, `usedAt`) is added rather than reusing the verification table for
resets too: a reset token authorizes changing a credential, a verification token only flips a
boolean, and conflating the two would let a leaked verification link double as an account-takeover
vector. Both use single-use tokens; verification consumes by deleting the row (`verificationTokens.ts`),
reset consumes with a conditional `UPDATE ... WHERE usedAt IS NULL AND expires > now() RETURNING`
(`passwordResetTokens.ts`) — one statement, not a `SELECT` then `UPDATE`, for the same TOCTOU reason
every other single-use resource in this codebase (the rate limiter's bucket, idempotent story
creation) is written as one statement: two concurrent consumptions of the same token must not both
succeed, and a read-then-write pair would let that happen.

**Tokens are compared via an index lookup, not `timingSafeEqual`.** `CRON_SECRET` needs
`timingSafeEqual` because it's a short, potentially-guessable value compared character-by-character
in application code — a real timing channel. A verification/reset token is a 256-bit random value
hashed and looked up by exact index match; there is no early-exit application-level comparison for a
timing side channel to ride on, and a 256-bit space is infeasible to brute-force regardless of
whether timing leaked anything. Bolting `timingSafeEqual` onto an already-indexed lookup would be
security theater, not a real hardening. See ADR 0048 for where constant-time comparison *is* the
right tool.

**A `Mailer` interface, mirroring `src/lib/providers/`'s registry pattern (ADR 0001)** —
`src/lib/email/types.ts`'s `Mailer` (one method, `send`), a `ConsoleMailer` that logs instead of
sending, a `ResendMailer`, and `getMailer()` selecting between them by `RESEND_API_KEY`.
`ConsoleMailer` is the default, which is what keeps dev, CI, and E2E fully keyless — signup still
sends a real verification email in every one of those environments, it just goes to the server
console instead of a network. `ResendMailer` talks to Resend's REST API directly via `fetch` rather
than adding the `resend` npm package: AGENTS.md's "check the stack already covers it" rule applied to
a single JSON POST, the same reasoning `openrouter.ts` already used to reuse an HTTP-capable client
instead of a dedicated SDK for a provider with no official one here.

**`ConsoleMailer` keeps an in-memory record of every send**, read back only by
`GET /api/__test/last-email` — gated on `E2E_TEST_MODE`, mirroring `%5F%5Fbench/roundtrips`'s
`BENCH_INSTRUMENTATION` gate exactly (404s, indistinguishable from a route that doesn't exist,
whenever that var isn't set — never in a normal build or deployment). This exists because a
verification/reset token is stored hashed and is otherwise unrecoverable once sent: without it,
`account-lifecycle.spec.ts`'s signup→verify→share and forgot→reset→old-session-rejected journeys
would have no way to reach the actual link short of skipping the flow they're supposed to prove.

**Uninformative responses, extended from ADR 0011.** `/password/request` returns the identical
`{ ok: true, message: … }` whether or not the address exists, or exists but has no password (a
Google-only account, which is silently skipped rather than sent a confusing "reset your password"
link) — same posture, same reason: a distinguishable response is an enumeration oracle.
`/password/reset` is the one place a specific failure ("this link is invalid or expired") is
deliberately informative: the token itself already proves the caller controls the account, so naming
the failure reveals nothing about whether an address exists.

**Login rate limiting is two independent buckets** (`LOGIN_IP`, `LOGIN_ACCOUNT`,
`src/lib/ratelimit/policy.ts`), because they defend different attacks the way `GENERATE_GUEST`'s and
admission control's own per-identity-plus-global caps already do: an IP-only limit is defeated by a
botnet spraying one account from many addresses, an account-only limit is defeated by one attacker
spraying many accounts from one address. Auth.js v5's Credentials `authorize()` receives the raw
request as its second argument, which is what makes checking the guard there possible at all —
extracted into `src/lib/auth/authorize.ts`'s `authorizeCredentials` rather than left inline in
`src/auth.ts`, specifically so it's unit-testable: `src/auth.ts` itself has no injection seam
(`src/test/session.ts`'s own note — `auth` is a destructured NextAuth export mocked at the module
level, the one module mock in this suite), so the only way to exercise the rate-limit and
timing-safety properties directly is to pull the logic that has them out from under that constraint.
The guard runs *before* the bcrypt compare (protecting the expensive operation, same reasoning as
`guardRegister`), but the compare itself still runs unconditionally against a lazily-memoized dummy
hash when no user matches — undoing that would resurrect the exact timing oracle ADR 0011 closed for
registration, just on the login path instead.

**A rate-limited login throws a distinguishable, client-safe error.** Auth.js maps a thrown
`CredentialsSignin`'s `code` property to the client-visible `signIn()` result's `code` field — never
`error`, which stays the generic `"CredentialsSignin"` for every credentials failure, by design (its
own doc comment: don't hint at *why* a credentials sign-in failed). `TooManyAttemptsError`
(`src/lib/auth/errors.ts`) sets `code = "too-many-attempts"`, which `/login`'s page checks to show
"Too many attempts" instead of the generic "Incorrect email or password." — the one place a
different message is safe to show, since it reveals a rate limit was hit, not whether the account
exists. Imported from `@auth/core/errors` directly, not `next-auth`'s own re-export: `next-auth`'s
package index unconditionally pulls in `next/server` at module scope, which breaks importing anything
from it in a plain Vitest/Node test process that isn't running inside Next itself.

**Auth events are logged, with the same allowlist discipline `logger.ts` already enforces
(`docs/adr/0022`).** `LOG_EVENTS` gains `LOGIN_FAILED`/`LOGIN_SUCCEEDED`/`EMAIL_VERIFIED`/
`PASSWORD_RESET_REQUESTED`/`PASSWORD_RESET_COMPLETED`, and `REGISTER_REJECTED` (defined since ADR
0022, never emitted) is finally wired up. Correlation uses `hashIdentity()` (`policy.ts`) — the same
hash-don't-store treatment the rate limiter already gives IPs — added to the field allowlist as
`identityHash`; a raw email address is never an allowed field, by the same structural guarantee that
already keeps a story paragraph or a raw IP out of a log line.

**Extended, not replaced: the hand-rolled validators, not a schema library.** `src/lib/story/validation.ts`
gains `MAX_PARAGRAPH_TEXT_LENGTH`/`MAX_STORY_PARAGRAPHS` next to the existing hint caps; the new auth
routes' bodies get the same kind of hand-written `isValidBody` predicate every existing route already
uses. No `zod` or equivalent: AGENTS.md requires checking whether the stack already covers a need, and
it does — the existing predicates are complete, 100%-covered, and already the shared trust boundary
ADR 0011 established.

## Rejected

- **Gating the write flow on verification.** Breaks guest-write parity and the US-6 resolution; the
  action worth gating is the one with a third-party consequence, and that is sharing, not writing.
- **Treating every Google sign-in as verified unconditionally, without reading `email_verified`.**
  Simpler, but throws away a signal Google actually provides for the rare case it reports false; using
  it costs nothing extra since the field is already on the profile.
- **Reusing `verificationToken` for password resets too.** Conflates a boolean-flipping token with a
  credential-changing one — a leaked verification link would become a takeover vector.
- **`timingSafeEqual` on the token lookups.** No early-exit comparison exists for it to defend against
  once the value is looked up by index; the actual protection is 256 bits of entropy, not the
  comparison method.
- **The `resend` npm package.** A single JSON POST doesn't earn a new dependency.
- **A schema-validation library for the new routes.** The existing hand-rolled predicates already are
  the trust boundary; growing them is smaller than a second validation system living alongside them.

## Consequences

- `src/lib/auth/**` and `src/lib/email/**` are held at the same 100% coverage tier as
  `ratelimit`/`kv`/`admission`/`budget` (`vitest.config.mts`) — token issuance/consumption and
  session-version comparison are exactly that tier's "a wrong branch is a real vulnerability" shape.
- `src/app/api/auth/**` route handlers sit at the same 90/85/90/90 tier as `generate`/`health` — route
  glue and provider/network error paths cost more to fully cover than they're worth.
- A contributor who clones the repo with no `RESEND_API_KEY` gets a fully working, testable
  verification/reset flow via `ConsoleMailer` — the same "guest flow always works" posture ADR 0009
  and ADR 0035 already apply to the database and Redis respectively, extended to email.
- `session.user.verified` (not `emailVerified` — see ADR 0047 for why the name had to change) is only
  ever refreshed at sign-in or on an explicit client `update()` call, so a Writer who verifies in one
  tab and switches to another before it refreshes sees a brief, harmless staleness window (blocked
  from sharing a little longer than strictly necessary) rather than any risk in the other direction.
