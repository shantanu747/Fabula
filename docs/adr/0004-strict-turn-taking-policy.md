# 4. Strict turn-taking policy

## Status

Accepted. Supersedes the original `docs/PRD.md`/`docs/use-cases.md` wording, which allowed the Writer and AI to add paragraphs "alternating as desired" — i.e. either side could add multiple paragraphs in a row.

## Context

Unconstrained turn-taking has two failure modes for a co-writing app: the AI can be asked to write several paragraphs consecutively (functionally turning "co-writing" into "AI writes the story, human clicks a button"), and a Writer can add several paragraphs in a row with no AI involvement at all, defeating the collaborative premise. It also complicates prompt construction: a story history with runs of same-author paragraphs doesn't map as cleanly onto a provider's alternating user/assistant message format.

## Decision

The AI may never generate two paragraphs in a row, and the Writer may never add two paragraphs in a row. From an empty story, either side may go first (this is the UC-1 vs. UC-2/UC-3 choice). Once a paragraph exists, whoever didn't write the most recent paragraph must write the next one.

This is enforced **server-side**, not just as a UI convenience: `src/app/api/generate/route.ts`'s `isAIsTurn()` check rejects a generation request with `409` if the last paragraph in the submitted history was AI-authored. The UI (`src/lib/story/turn.ts`'s `isAIsTurn`/`isWritersTurn`, mirrored client-side) disables the corresponding action button so a well-behaved client should never actually trigger the 409 — but the server check exists regardless, since the client is not a trusted boundary and the API is the actual authority over story state legality.

## Consequences

- `docs/use-cases.md`'s UC-4 and UC-5 preconditions were updated to state this explicitly; `docs/PRD.md`'s core user journey description was updated from "alternating as desired" to "strictly alternate, one paragraph per turn."
- Because turns strictly alternate by construction, `src/lib/providers/prompt.ts`'s conversion of story history into chat messages never has to handle consecutive same-author entries — no message-merging or role-normalization logic is needed, which simplified that code relative to an earlier draft that assumed free-form alternation.
- A future feature request to relax this (e.g. "let the AI write a few paragraphs to catch up") would need to reconsider both the server check and the simplified message-mapping logic that now depends on strict alternation always holding.
