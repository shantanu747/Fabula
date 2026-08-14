# 10. Shared story feed and safety

## Status

Accepted.

## Context

Alongside accounts and persistence (`docs/adr/0009-accounts-and-persistence-architecture.md`), the Writer asked for "a foundation for a social aspect" — letting Writers share stories with other users. The shape of that (a browsable feed visible only to signed-in Writers, not public links or direct user-to-user sharing) and its safety posture (a visible disclaimer plus a basic non-blocking report action, no moderation queue in this pass) were both resolved directly with the Writer before implementation. What this record covers is the reasoning behind that shape and, more importantly, making the deferred scope explicit so it reads as a deliberate boundary rather than a gap discovered later.

## Decision

**Feed, not public links or direct sharing**: a shared story becomes visible to any other *signed-in* Writer via a paginated `/feed`, gated by `stories.isShared` and enforced both at the route layer (`src/proxy.ts` redirects signed-out requests) and per-request in `api/feed/*` (`auth()` re-checked, not just relied on from the proxy). Public/unauthenticated links were explicitly not built — sharing is scoped to the signed-in Writer community, not the open internet, which keeps the safety surface (see below) bounded to accounts that exist and can be identified if reported. Direct Writer-to-Writer sharing (e.g. "share with this specific person") was also not built — the feed is the only sharing mechanism in this pass, which is simpler and matches what was actually asked for over building a permissions model for targeted sharing that nothing yet needs.

**Unmoderated by design, mitigated not solved**: shared content is human-written (and AI-collaborated) text with no review step before it appears in the feed. Rather than build moderation tooling — which is a substantial, separate scope (queues, reviewer roles, takedown flows) — this pass ships two lightweight mitigations: a persistent, visible disclaimer on `/feed` stating that content is unmoderated, and a one-click "Report" action on every shared story (`storyReports`, unique per `storyId`+`reporterId` so repeat reports from the same Writer are a no-op rather than spam or an error). Reports are recorded, not actioned — there is no queue, no notification, no automatic unsharing on report count. This is a conscious, named gap: the mitigation is *transparency and a recorded signal*, not *enforcement*. A real moderation story (review queue, auto-hide thresholds, admin tooling) is future scope if the feed sees real usage, not something this pass pretends to solve partially.

**Read-only feed views**: `/feed/[id]` renders a shared story's paragraphs with author attribution but no compose box, no interaction beyond reading and reporting — no comments, likes, or follows. This keeps the feed a browsing surface, not a second write surface, which avoids a much larger set of questions (can another Writer continue someone else's shared story? edit it? fork it?) that weren't asked for and that `docs/PRD.md`'s non-goals already flag as undecided for collaborative multi-user sessions.

## Consequences

- The feed's safety posture depends entirely on the account being real and traceable — since sharing requires an account (not a guest action) and reporting is tied to a reporter's account, there's at least an identifiable trail if abuse needs to be investigated manually, even though nothing automated acts on it yet.
- Because there's no moderation queue, a report today has no operational consequence beyond existing in the database — if the Writer wants reports to actually do something (surface to an admin view, auto-hide past a threshold), that's new scope, not a bug in this pass.
- A shared story can be unshared by its owner at any time (`PATCH /api/stories/:id`), which is the only takedown mechanism that exists right now — there's no path for a *different* Writer or an admin to remove a shared story from the feed.
- If direct sharing or public links are wanted later, they're additive on top of this model (the `isShared` flag and feed don't need to change) rather than a replacement for it — this pass's choice doesn't foreclose either.
- No rate limiting exists on how often a story can be shared/unshared or how many reports a single Writer can file — acceptable for this pass given the same "no accounts-based rate limiting" posture `docs/PRD.md`'s v1 key risks already accepted for generation itself, but worth revisiting together if either surface sees abuse.
