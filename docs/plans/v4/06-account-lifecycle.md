# Plan 6 — Account lifecycle and auth hardening

**Branch:** `feature/account-lifecycle`
**Depends on:** Plan 2, for the rate-limit policies and the Redis client. Otherwise independent of
plans 3–5 and can run alongside them. *If Plan 2 isn't merged yet:* use the existing Postgres token
bucket for the login guard and leave the Redis token-version cache to a follow-up.
**ADRs:** three — lifecycle and the mailer abstraction, session revocation, and the origin/prompt
trust boundary.

## Why this exists

The authentication that exists is well built — bcrypt cost 12, uninformative registration responses,
origin-resolved redirect validation (ADR 0011), UUIDv4 ids, ownership re-checked on every story
route. What is missing is everything around it.

**`authorize()` has no rate limit of any kind.** `src/auth.ts:33-45` runs a `SELECT` and a
`bcrypt.compare` with no guard, no attempt counter, and no lockout. `guard.ts` covers
`/api/generate`, `/api/health`, and `/api/auth/register` only — `/api/auth/[...nextauth]` is not in
the list. Online password guessing against this app is bounded only by network throughput. **This is
the most serious finding in the v4 review.**

**No email verification.** `users.emailVerified` and the `verificationToken` table exist because
`@auth/drizzle-adapter` requires the shape; nothing writes either. Consequence: register an address
you do not own, and because `allowDangerousEmailAccountLinking` is (correctly) unset, you have
blocked that address's real owner from ever signing in with Google —
`OAuthAccountNotLinked`. Account squatting. (Takeover in the other direction is already closed:
`onConflictDoNothing` on email, plus `authorize()` returning null when `passwordHash` is absent.)

**No password reset.** No route, no token, no link on `/login` (`:106-111` offers only `/signup`).
A forgotten password means a lost account.

**No session revocation and no `maxAge`.** `strategy: "jwt"` (`auth.ts:22`) with no `maxAge` set
means the Auth.js 30-day default. There is no `tokenVersion`, no denylist. A stolen token is valid
for a month and nothing can stop it. ADR 0009 accepted this; at v4 it is worth revisiting.

**No CSRF protection on the app's own routes.** Auth.js protects `/api/auth/*`. Nothing else has an
Origin check or a token. **`POST /api/stories/[id]/report` reads no body at all**
(`report/route.ts:6`), which makes it a CORS-*simple* request: no preflight, cross-site forgeable
today. The others require `Content-Type: application/json`, which does force a preflight — that is
an accident of body shape, not a control.

**Unbounded input into the model.** `isStoryParagraph` (`src/lib/story/validation.ts:13-21`) caps
nothing; `isStoryParagraphArray` (`:23-25`) caps nothing. That file's comment at `:10-11` states
"The UI enforces the same bounds" and **`grep -rn "maxLength" src/` returns zero hits** — the theme
input (`page.tsx:86`), both textareas (`:120`, `:138`), and the Writer's paragraph textarea
(`story/page.tsx:225`) have none.

**No prompt delimiting.** `buildKickoffInstruction` (`prompt.ts:115-137`) and
`buildOngoingContextNote` (`:76-81`) concatenate raw user text after plain labels. The one thing done
right is that `buildSystemPrompt()` takes no arguments and interpolates nothing — user text never
enters the system role. Keep that property.

**No auth logging at all.** `src/auth.ts` logs nothing; failed `authorize()` returns bare `null`.
`LOG_EVENTS.REGISTER_REJECTED` is defined at `logger.ts:16` and **never emitted anywhere**.

## What "done" means

- Password guessing is rate limited per IP **and** per account.
- Signup sends a verification email; unverified accounts can still write, but cannot share.
- A forgotten password is recoverable, and reset invalidates existing sessions.
- Sessions can be revoked, without reintroducing a database read on every page render.
- Cross-site requests cannot mutate state — `report` included.
- Every user-controlled string has a server-side maximum, and the UI enforces the same bound.
- User text reaches the model inside explicit delimiters it cannot escape.
- Auth events are logged, without logging email addresses.

## Files

### `src/lib/email/` (new)

A `Mailer` interface with a Resend adapter and a `ConsoleMailer`, registry-selected by env —
deliberately the same pattern as `src/lib/providers/` (ADR 0001). `ConsoleMailer` is the default
when no key is configured, which keeps dev, CI, and E2E keyless and makes the flows testable without
a network.

Do not call an email SDK from a route handler. Same rule, same reason.

### Email verification

- Reuse the **existing** `verificationToken` table (`schema.ts:65-73`). Store a hash of the token,
  not the token.
- `POST /api/auth/verify/request` (rate limited) and `GET /api/auth/verify/[token]`. Single use,
  short expiry, constant-time comparison.
- **The gating decision, and the interesting part of this plan.** Unverified users can **write** —
  gating the core flow would violate the US-6 resolution and break parity with the fully-supported
  guest path. They cannot **share to the feed**. That is the action with a third-party consequence,
  so it is the action worth gating, and it closes the squatting hole at the point where it matters.
  Enforce server-side in `PATCH /api/stories/[id]`, not only in the UI.

### Password reset

- A new table: user id, token **hash**, expiry, single-use marker.
- `POST /api/auth/password/request` → always the same response whether or not the address exists
  (ADR 0011's uninformative-response posture), rate limited per IP and per address.
- `POST /api/auth/password/reset` → verify, set the new hash, **bump `tokenVersion`** so existing
  sessions die, mark used.
- `/forgot` and `/reset` pages, plus the link on `/login` that does not exist today.

### Session revocation — `src/auth.ts` + `src/lib/auth/`

`user.tokenVersion` (integer, default 0), stamped into the JWT and bumped on password reset or an
explicit "sign out everywhere".

**The problem worth reasoning about in an ADR:** checking it naively destroys the property ADR 0009
bought — `auth()` is currently a cookie signature verification with **zero database round trips**,
including in `proxy.ts` on every protected navigation. A `SELECT` per page load would be a real
regression.

Resolution:

- **Do not check on render.** Page and layout renders keep the zero-round-trip path.
- **Check on mutating API routes**, where one extra read is negligible against the work already
  being done.
- **Check in the `jwt` callback on refresh**, using Auth.js's `updateAge` so a revoked session dies
  within a bounded window without per-request cost.
- **Cache the current version in Redis**, so even the mutating-route check is sub-millisecond, with
  a Postgres read as the fallback.

State the residual window honestly: a revoked session can survive on read-only pages until its next
refresh. That is a deliberate trade, not an oversight, and it is far better than the 30-day
unbounded window today.

Also set an explicit `session.maxAge`. Thirty days by omission is not a decision.

### Login rate limiting

`guardLogin` with **two** buckets, because they defend different attacks:

- **Per IP** — one attacker spraying many accounts.
- **Per account (hashed email)** — many IPs targeting one account. A botnet defeats an IP-only
  limit entirely.

Auth.js v5's `authorize` receives the request, so the guard can run there. Keep the timing
characteristics uniform: `register` already computes the bcrypt hash on both branches
(`register/route.ts:47-51`) so the response time does not reveal existence. Do not undo that
property here by short-circuiting before the compare.

### `src/app/api/auth/register/route.ts` (modify)

- **Reject passwords over 72 bytes explicitly.** bcryptjs silently truncates at 72, so today a
  128-character password is effectively its first 72 — and worse, two different long passwords can
  be equivalent. Measure **bytes**, not characters.
- Maximum lengths on name, email, and password (`isValidBody` at `:12-23` has none).
- Emit `REGISTER_REJECTED`, which has been defined and unused since ADR 0022.

### Origin checks — `src/lib/security/assertSameOrigin.ts` (new)

Applied to every mutating route: `generate`, `stories` POST, `stories/[id]` PATCH, `report`,
`register`, and the new password/verify routes.

Compare `Origin` against the resolved request origin. Reuse the origin-resolution approach from
`src/lib/auth/callbackUrl.ts:14-23` rather than writing a second one — that file exists because
prefix matching was wrong there, and the same bypasses apply here. Reject on absent `Origin` for
state-changing methods.

`src/lib/security/` currently holds `csp.ts` only; both files belong to the same posture (ADR 0024).

### Input caps — `src/lib/story/validation.ts` + the UI

- Cap `StoryParagraph.text` and the array length, with constants in
  `src/lib/story/constants.ts` next to the existing hint caps (`:15-16`).
- Add a body size limit on every route.
- Add `maxLength` to all four inputs so the file's own claim at `:10-11` becomes true. Show the user
  the limit rather than silently truncating.

`src/lib/story/**` is at **100% coverage**; boundary cases need tests.

### Prompt trust boundary — `src/lib/providers/prompt.ts`

- Wrap user-supplied theme, characters, and opening lines in explicit delimiters in
  `buildKickoffInstruction` (`:115-137`) and `buildOngoingContextNote` (`:76-81`).
- **Strip or escape the delimiter from user input** before wrapping. A delimiter the user can emit
  is not a boundary.
- Add one clause to `buildSystemPrompt()`: content inside the delimiters is story material and never
  instructions.
- **Keep the system prompt argument-free.** Its taking no parameters is a structural guarantee, like
  the logger's allowlist — do not weaken it to pass user data.

This is mitigation, not a solution: prompt injection is not solved by delimiters. Say so in the ADR.
The real containment is that the model's output is only ever rendered as text by React (no
`dangerouslySetInnerHTML` anywhere) and cannot reach a tool or a privileged action — there are none.

If Plan 4 landed, note that its framed protocol removes the model-emits-the-sentinel confusion by
construction, since metadata no longer travels in-band.

**These prompt files have snapshot tests in `evals/`. Changing the prompt will fail
`npm run eval` — that is the harness working as designed (ADR 0018). Re-record deliberately and
review the diff.**

### Auth logging — `src/lib/observability/logger.ts`

Add and **emit** `auth.login_failed`, `auth.login_succeeded`, `auth.password_reset_requested`,
`auth.password_reset_completed`, `auth.email_verified`, plus the already-defined
`register.rejected`.

The allowlist (`:30-47`) is a structural privacy guarantee — **never add `email` to it.** Log a hash
if correlation is needed, the same way `policy.ts:95-98` hashes IPs so the database is not a record
of who used the app.

### Small authorization fixes

- `src/app/feed/[id]/page.tsx` — call `auth()` in the page, not only in `proxy.ts`. Every other
  story-touching surface re-checks (`library/page.tsx:10-14`); this one relies solely on middleware.
- `src/proxy.ts:50-57` — the matcher's `missing` clause skips requests carrying prefetch headers, so
  the auth redirect does not run for them. Close it or confirm in the ADR why it is safe.
- `/api/health` — drop the commit SHA and uptime from the unauthenticated response, or gate the
  detailed body. Keep the key-presence booleans (they are booleans, never key material) and keep it
  unauthenticated: it must work when auth is broken (ADR 0022).

### Explicitly: **do not add `zod`**

`AGENTS.md` requires checking whether the stack already covers a need. The hand-rolled predicates in
`validation.ts` are complete, 100%-covered, and shared across the trust boundary. Extend them. This
is written here so the question is not reopened mid-implementation.

## Tests

- Login rate limit — per-IP and per-account buckets both fire; a correct password is still rejected
  while limited; no timing oracle is introduced.
- Verification — token single-use, expiry, hash-not-plaintext storage, wrong token rejected;
  unverified user **can** write and **cannot** share (asserted server-side).
- Reset — uninformative response for unknown addresses; single use; sessions invalidated after
  reset.
- Revocation — bumping `tokenVersion` rejects the old token on a mutating route; **assert page
  renders still perform zero database queries** (this is the property being protected, so test it
  directly, using the Plan 1 round-trip counter).
- Origin — cross-origin POST rejected on every mutating route; **`report` specifically**, since it
  is the one forgeable today; same-origin passes; absent Origin rejected.
- Input caps — at/over the boundary for every field; a 73-byte password rejected; oversized body
  rejected.
- Prompt — a delimiter in user input is escaped; an injection string appears as story material;
  snapshots updated.
- Logging — auth events emitted with the right names; **an email address can never reach a log
  line**.
- E2E — signup → verify → share; forgot → reset → old session rejected; login lockout.

## Verification

Full CI reproduction, plus:

- Both flows by hand with `ConsoleMailer`: signup → verify link from the console → share succeeds;
  and share **before** verifying fails cleanly with a clear message.
- Forgot → reset → confirm a session open in another browser is rejected on its next mutation.
- Confirm the login limiter blocks a scripted attempt loop.
- Re-record eval snapshots deliberately; review the prompt diff in the PR rather than accepting it.
- New pages (`/forgot`, `/reset`, verification states) at ~375px; bundle budget after a clean build.

## Gotchas

- **Uninformative responses everywhere.** Verification and reset must not reveal whether an address
  exists — same status, same body, comparable timing. ADR 0011 established this for register; it is
  easy to lose in new routes.
- Store token **hashes**. A leaked database of live reset tokens is a full compromise.
- Constant-time comparison for tokens and `CRON_SECRET`.
- Do not gate writing on verification. Guest writing is fully supported and un-gated by design; a
  signed-in unverified user must not be worse off than a logged-out one.
- The `session` table exists and is never used (JWT strategy). Do not "fix" that — ADR 0009 explains
  that database sessions would silently break the Credentials provider.
- `src/lib/story/**` and `src/lib/providers/prompt.ts` are at 100% coverage.
- Do not import the server logger into a `"use client"` module.

## Out of scope

- Facebook OAuth, 2FA/TOTP, magic links, WebAuthn, account deletion/export, admin tooling,
  a moderation queue (PRD §3 non-goals).
- Replacing JWT sessions with database sessions.
- A CAPTCHA.

## ADRs

**`docs/adr/00NN-account-lifecycle-and-mailer-abstraction.md`**

- Why a `Mailer` interface mirroring the provider registry, and why `ConsoleMailer` is the default.
- **Why verification gates sharing but not writing** — the US-6/guest-parity reasoning, and why the
  action with a third-party consequence is the right gate.
- How this closes account squatting, and what it does not close.
- Why tokens are stored hashed and responses are uninformative.

**`docs/adr/00NN-session-revocation-without-per-request-reads.md`**

- The constraint: ADR 0009's JWT choice bought zero database reads per render, and a naive version
  check spends it.
- Where the check runs (mutating routes and JWT refresh) and where it does not (renders).
- The residual window, stated plainly, versus today's unbounded 30 days.
- Why the Redis version cache is an accelerator over a Postgres source of truth (Plan 2's rule).
- Why `session.maxAge` is now explicit.

**`docs/adr/00NN-origin-checks-and-the-prompt-trust-boundary.md`**

- Why JSON content-type was never a CSRF control, and why `report` was genuinely exposed.
- Why origin resolution reuses `callbackUrl.ts`'s approach rather than prefix matching.
- The prompt boundary: delimiting plus escaping plus an argument-free system prompt, and an honest
  statement that this is mitigation, not a solution — with the real containment being that model
  output reaches no tool and is rendered only as text.
- Why the existing hand-rolled validators were extended rather than replaced with a schema library.
