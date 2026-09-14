# 48. Origin checks and the prompt trust boundary

## Status

Accepted.

## Context

`docs/plans/v4/06-account-lifecycle.md`'s review found no CSRF protection anywhere on this app's own
mutating routes. `Content-Type: application/json` was never a real control — it happens to force a
CORS preflight today, which is an accident of body shape, not a decision anyone made.
`POST /api/stories/[id]/report` reads no body at all (`report/route.ts`), which makes it a
CORS-*simple* request: no preflight, forgeable today from a bare cross-site `<form>`. Separately, the
review found every user-controlled string reaching a provider prompt with no length cap and no
delimiter — `isStoryParagraph`/`isStoryParagraphArray` capped nothing, and `buildKickoffInstruction`/
`buildOngoingContextNote` concatenated raw Writer text after plain labels with no boundary a model
could be told to respect.

## Decision

**`src/lib/security/assertSameOrigin.ts`, applied to every mutating route** — `generate`, `stories`
POST, `stories/[id]` PATCH, `stories/[id]/paragraphs` POST, `report`, `register`, and the new
verify/password routes. Compares the `Origin` header against `new URL(request.url).origin` — this
server's own view of what it was reached at — and rejects on any mismatch or on an absent header.
`stories/[id]/paragraphs` is not in the plan's own enumerated list (added to this codebase after the
plan was written, by the durable-Writer-turns work) but is unambiguously a mutating route under the
plan's stated rule ("applied to every mutating route"), so it's included here rather than left as a
gap the plan's list happened to miss.

**Full-origin string equality, not `safeCallbackUrl`'s resolve-then-compare approach, and that's a
deliberate difference, not a shortcut.** ADR 0011's `safeCallbackUrl` needs origin *resolution*
because its input is a path-shaped value that a browser's URL resolver could reinterpret as absolute
(the `/\evil.example` backslash-normalization bypass that record exists to document). An `Origin`
header is never a relative path — it's already either a fully-qualified origin or absent — so there is
no equivalent ambiguity for exact-string equality to fall into. Reusing `safeCallbackUrl` itself here
would be reusing a resolver built for a problem this input doesn't have.

**Absent `Origin` is rejected, not treated as same-origin.** Every mutating call this app's own
frontend makes is a same-origin `fetch()`, which always sends `Origin` — requiring it costs real
clients nothing, and it closes off exactly the bare cross-site `<form>` POST that has no reason to
omit it except to dodge this check.

**Body size is bounded on every mutating route** (`src/lib/http/readJsonBody.ts`), reading the whole
body as text and measuring it rather than trusting a caller-supplied `Content-Length`. Two tiers:
`DEFAULT_MAX_BODY_BYTES` (16 KB) for routes bounded by small field-level caps already (auth forms,
share/target-length toggles), and `STORY_BODY_MAX_BYTES` (2 MB) for the two routes carrying a full
`storySoFar` array (`/api/generate`, `/api/stories/[id]/paragraphs`) — sized comfortably over
`MAX_STORY_PARAGRAPHS` (200) × `MAX_PARAGRAPH_TEXT_LENGTH` (4000) plus JSON overhead, not a tight fit
around that product. Reading the full body before measuring, rather than a manually byte-counted
streaming reader, is deliberate: real complexity this app's actual exposure doesn't warrant, given
the platform's own request-body ceiling is already the backstop against a truly unbounded stream —
this exists to reject a merely-oversized JSON payload cleanly, not to defend against an attacker who
ignores `Content-Length` and streams indefinitely.

**New field caps: `MAX_PARAGRAPH_TEXT_LENGTH` (4000) and `MAX_STORY_PARAGRAPHS` (200)**
(`src/lib/story/constants.ts`, extending `isStoryParagraph`/`isStoryParagraphArray` in
`validation.ts` — the same shared trust boundary ADR 0011 established, grown rather than replaced,
per AGENTS.md's "check the stack already covers it" and the plan's explicit instruction not to
introduce `zod`). Both generous relative to real use — `MAX_PARAGRAPH_TEXT_LENGTH` is roughly 20x the
AI's own ~80–180-word target, `MAX_STORY_PARAGRAPHS` roughly 7x `MAX_TARGET_LENGTH`'s 30-paragraph
soft target — so a real Writer never notices either limit. The UI enforces the same bounds via
`maxLength` on all four previously-uncapped inputs (theme, characters, opening lines, the Writer's
paragraph textarea) and shows the limit rather than silently truncating: a small always-visible
counter on the three start-flow fields, and a conditional one on the story composer that stays silent
until a Writer is within 300 characters of the cap — chosen specifically so the composer's deliberate
chrome-free minimalism (ADR 0031) isn't disturbed by a counter nobody is close enough to need yet.

**Prompt delimiting, in `buildKickoffInstruction` and `buildOngoingContextNote`/
`buildContinuationMessage`** (`src/lib/providers/prompt.ts`): every piece of Writer-supplied text —
theme, characters, opening lines — is wrapped in `<<<STORY_MATERIAL>>>…<<<END_STORY_MATERIAL>>>`
before being concatenated into the instruction string sent to the model. `buildSystemPrompt()` gains
one static bullet naming those exact markers and stating that content between them is story material,
never an instruction — the function still takes zero arguments and interpolates nothing, so its
existing "argument-free, therefore no user data can reach the system role" guarantee is unweakened.
The per-turn `storySoFar` paragraphs themselves are deliberately *not* wrapped: they already have a
structural boundary the delimiter would be redundant with — `buildMessages` maps each one to its own
role-tagged chat message (`user` for the Writer, `assistant` for the AI), so the model already
receives them as distinctly-bounded turns, not as text concatenated into one string the way the three
hint fields are.

**A delimiter the Writer can type is not a boundary, so it's stripped from their own input before
wrapping.** `delimitUserText` removes any literal occurrence of either marker from the supplied text
before adding real ones around it — an attempt to forge a closing marker to smuggle fake
"instructions" outside the wrapped region just has that marker deleted instead.

**Stated plainly: this is mitigation, not a solution.** A sufficiently determined injection can still
try to talk its way past a delimiter the model was merely told to respect — no prompt-level defense
closes that off completely. The actual containment is structural, not prompt-level: this app renders
model output only as text, through React, with no `dangerouslySetInnerHTML` anywhere in the codebase,
and that output reaches no tool and no privileged action — there are none for it to reach. The worst a
fully successful injection achieves is unwanted prose in the story, not unwanted behavior anywhere
else. If Plan 4's framed streaming protocol (ADR 0042) is read alongside this: it already removes a
related but distinct confusion — the model emitting a fake sentinel to fabricate out-of-band
metadata — by construction, since metadata no longer travels in-band as text the model could imitate.

**Prompt snapshot tests were re-recorded deliberately, not accepted blind.** `prompt.test.ts` and
`prompt.sentinel.test.ts` needed no changes beyond what the delimiter wrapping itself implies (both
already assert with `.toContain(...)` on the Writer-supplied substrings, which still appear, now
inside markers) — verified by running the existing suite rather than assumed, per ADR 0018's "a
failing snapshot is the harness working as designed, not noise to silence."

## Rejected

- **Reusing `safeCallbackUrl`'s resolve-then-compare logic for Origin checking.** Built for a
  different bug (a relative path reinterpreted as absolute); an `Origin` header has no equivalent
  ambiguity for exact-string comparison to fall into.
- **A manually byte-counted streaming body reader.** The platform's own request-size ceiling is
  already the real backstop against an attacker who ignores `Content-Length`; this exists to reject a
  merely-oversized JSON payload cleanly, which reading-then-measuring already does.
- **Wrapping `storySoFar` paragraphs in the same delimiter as the hint fields.** They already carry a
  stronger, structural boundary (per-turn role-tagged messages); adding a textual one too would be
  redundant, not additive.
- **Treating prompt delimiting as sufficient on its own.** It's a mitigation layered on top of the
  real containment (no tool access, output rendered only as text) — stated in the ADR precisely so a
  future reader doesn't mistake the delimiter for the whole answer.

## Consequences

- `src/lib/security/**` (including the pre-existing `csp.ts`) and `src/lib/http/**` are held at the
  100% coverage tier (`vitest.config.mts`) — a missed branch in either is a forgeable mutating route
  or a body-size check that doesn't actually check, not a cosmetic gap.
- Every existing E2E spec and Vitest route test that drives a mutating route directly (via
  `page.request`/`APIRequestContext` rather than a real browser `fetch()`) needed an explicit `Origin`
  header added — `APIRequestContext` doesn't attach one automatically the way a browser does. Fixed at
  every call site this pass touched; a new direct-API-request test added later needs the same header
  or it will 403 against this check, not against whatever it meant to test.
- `MAX_PARAGRAPH_TEXT_LENGTH`/`MAX_STORY_PARAGRAPHS` are engineering judgment calls, generous enough
  not to affect real use today, in the same spirit ADR 0011 already named for the hint-length caps —
  the right thing to revisit if a real use case ever needs a longer single turn or a much longer
  story.
