# 47. Session revocation without per-request reads

## Status

Accepted. Deliberately narrower than `docs/plans/v4/06-account-lifecycle.md`'s own proposed
mechanism — see Context for why, and Rejected for what was dropped and why that's the right call at
this app's scale.

## Context

ADR 0009 accepted "specific session revocation isn't possible" as a JWT-strategy tradeoff and
explicitly left it for later. The plan's own instruction for closing that gap was: check
`tokenVersion` on mutating routes, and additionally "in the jwt callback on refresh, using Auth.js's
`updateAge`" — the idea being a revoked session would die within a bounded window on *reads* too,
without paying a database round trip on every render.

That second half doesn't correspond to how Auth.js v5 actually behaves for JWT-strategy sessions.
Reading `@auth/core`'s own `session()` action (`lib/actions/session.js`): for `session.strategy: "jwt"`,
`callbacks.jwt()` runs **unconditionally on every call**, including every `auth()` call this app makes
on every protected page render (`proxy.ts`, every route handler, every RSC page) — there is no
`updateAge`-gated "refresh only" branch for JWT sessions; that gating exists solely in the adjacent
*database*-session code path, which this app doesn't use (ADR 0009). Following the plan's literal
instruction — put a `tokenVersion` check inside the `jwt()` callback and lean on `updateAge` to make it
infrequent — would either add a Redis/Postgres read to every single render (exactly the regression
ADR 0009's "zero database round trips" property exists to prevent) or silently never fire, depending
on which part of the misunderstanding got implemented. Verified against the installed
`@auth/core`/`next-auth` source directly, not assumed from the docs.

## Decision

**Checked only on mutating routes, never on render — full stop, no jwt-callback mechanism at all
for the read path.** `src/lib/auth/tokenVersion.ts`'s `assertSessionCurrent` is called explicitly,
right after confirming a session exists, in every route that changes state: `/api/generate`,
`POST /api/stories`, `PATCH /api/stories/[id]`, `POST /api/stories/[id]/paragraphs`,
`POST /api/stories/[id]/report`. Page renders and GET routes are untouched — `auth()`'s cookie-only,
zero-round-trip property (ADR 0009) is preserved exactly as it is today.

**The residual window is accepted, stated plainly, and bounded by `session.maxAge` alone
(14 days, set explicitly in `src/auth.ts` — 30 days by omission was never a decision).** A revoked
session that is never used to write anything can still read pages until that JWT's own expiry. This
is a real, deliberate tradeoff, not an oversight, and the reasoning for accepting it — rather than
building the more elaborate mechanism the plan sketched — is the actual point of this record:

At this app's current scale (a small, non-production user base), the elaborate alternative — a
`tokenVersionCheckedAt` claim embedded in the JWT, self-throttled inside `jwt()` to re-validate
against Redis/Postgres only once every few minutes regardless of render-vs-mutating-route — was
designed, and rejected. It would work, and it would tighten the read-path window to minutes instead
of up to 14 days. But it adds a second revocation-checking code path, a new claim whose staleness has
to be reasoned about independently of the token version it's protecting, and genuine complexity for a
threat this deployment does not yet have: the mutating-route check already stops the actions that
actually matter — spending generation budget, writing content, sharing to the feed, changing an
account's own password — immediately, on the very first attempt after revocation. What's left exposed
is read-only access to a Writer's own already-written stories, for as long as the stolen JWT's expiry
allows. A staff engineer's job is recognizing when *not* to build the more sophisticated mechanism,
not only when to build it; this is that case, made explicitly rather than left as a silent gap.

**`bumpTokenVersion` is invoked from exactly one place today: a completed password reset**
(`POST /api/auth/password/reset`). The mechanism is generic — any future action that needs to kill
every outstanding session for an account (an explicit "sign out everywhere" button, say) calls the
same function — but no such UI is built in this pass. It isn't asked for by any use case, and the
plan itself frames it as the secondary trigger alongside password reset, not the deliverable; adding a
settings surface with no other purpose than hosting that one button is scope this pass doesn't need.

**Cached in Redis, Postgres as the source of truth underneath** — `getCurrentTokenVersion` reads the
cache first (`tokenver:<userId>`, 60s TTL) and falls through to a `SELECT` on a miss, mirroring
`src/lib/ratelimit/store.ts`'s Redis-then-Postgres shape and ADR 0035's "Redis is never
authoritative" rule exactly: with no Redis configured, every mutating-route check still works, just
paying a Postgres read every time instead of most of the time. `bumpTokenVersion` deletes the cache
key rather than writing the new value directly — a concurrent bump racing a stale write would let the
stale one win; forcing the next read to reload from Postgres cannot go wrong the same way.

**`session.user.verified`, not `session.user.emailVerified`.** The natural name collided with how
`@auth/core` types `AdapterUser.emailVerified` (`Date | null`, used generically depending on whether
an adapter is configured) — assigning a `boolean` under that name inside the `session()` callback
failed to type-check against a conditional type TypeScript derived from that generic. Renamed the
session-level boolean rather than fighting the collision; `users.emailVerified` (the real `Date | null`
column, and the `User`-shaped field Auth.js's own plumbing expects) is untouched everywhere else.

**Refreshed only on an explicit client `update()` call, never automatically.** `src/auth.ts`'s `jwt()`
callback reads `trigger === "update"` and only then re-queries `tokenVersion`/`emailVerified` from
Postgres — the one piece of I/O this callback ever does outside of sign-in, and it only runs when
`next-auth/react`'s `useSession().update()` is called from the client, which `src/app/verify/page.tsx`
does on landing at `?status=success` so a Writer who just verified sees the share gate clear without
waiting for a fresh sign-in. Getting `update()` to actually trigger the server's `isUpdate` branch
requires passing it a (even empty) data argument — `update({})`, not the argument-free `update()` —
because `next-auth/react`'s client only sends a POST (the only request shape `@auth/core` treats as an
update rather than a plain re-fetch) when its own `data` parameter is not `undefined`. Found by
reading `next-auth/react.js`'s `fetchData` directly after `update()` alone silently did nothing in
practice — confirmed against the real client/server pair via `account-lifecycle.spec.ts`'s E2E
journey, not assumed from the API's shape.

## Rejected

- **A `tokenVersionCheckedAt` claim, self-throttling the check inside `jwt()` for every call
  (render included).** Real cleverness for a problem this app's current scale doesn't have; the
  mutating-route check already protects everything that matters immediately, and the render-path gap
  it would close is read-only access to a Writer's own content.
- **Checking Redis unconditionally inside `jwt()` on every call.** Exactly the regression ADR 0009's
  zero-round-trip property exists to prevent, whether the backend answering it is fast or not — the
  point is that render pays nothing, not that it pays little.
- **A "sign out everywhere" UI in this pass.** `bumpTokenVersion` is generic enough to back one later;
  building the surface now, with only password-reset as its trigger, is scope beyond what was asked.
- **Shortening `session.maxAge` alone as a substitute for the mutating-route check.** A JWT session is
  rolling — every request re-signs the cookie with a fresh expiry (the same `session()` action this
  record already examined) — so `maxAge` alone bounds an *idle* stolen token, not an actively-used one;
  it complements the mutating-route check, it cannot replace it.

## Consequences

- `auth()`'s zero-database-round-trip property (ADR 0009) is unchanged by this plan, on every render
  and every read route, exactly as before.
- A revoked session's write access dies on its very next attempt; its read access dies within
  `session.maxAge` (14 days) if idle, or persists until then if actively read but never written to.
  Stated here so it isn't rediscovered as a surprise later.
- `src/lib/auth/tokenVersion.ts` sits at the same 100% coverage tier as `ratelimit`/`kv`/`admission`
  (`vitest.config.mts`) — a wrong branch here is either a revoked session staying live or a live one
  being wrongly rejected, the same "expensive to get wrong" shape that tier already exists for.
- Revisit the self-throttled-claim design (Rejected, above) if this app ever has enough real traffic
  and enough at stake that a 14-day read-only exposure window on a stolen-but-otherwise-idle token
  stops being an acceptable tradeoff — the constraint that makes it acceptable today is scale, not
  principle, and scale changes.
