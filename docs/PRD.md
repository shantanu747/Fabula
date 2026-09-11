# Fabula — Product Requirements Document

## 1. Problem

Writers (casual and hobbyist) want a low-friction way to co-write short fiction with an AI collaborator — providing a spark (genre, characters, opening lines) and either writing the first paragraph themselves or letting the AI kick things off, then continuing the story together.

## 2. Goals (v1)

- Let a user start a story with minimal input: genre/theme (optional), starter characters (optional), a few opening lines (optional).
- If no input is given, the AI invents a theme/characters and starts the story itself.
- User can choose to write the first paragraph themselves, or click "Get me started" to have the AI write it.
- User can select which LLM provider/model generates AI turns (Anthropic, OpenAI, or an open-weight model via an aggregator), swappable per generation.
- Story generation and full session state (all paragraphs, choices, provider used) persist only for the browser session — no accounts, no database in v1.
- Fast perceived response: AI paragraphs stream in, not a blocking spinner.

## 3. Non-goals (v1) and confirmed v2 direction

**v1 non-goals** — undecided, not yet scoped:

- Collaborative multi-user sessions (two humans + AI)
- Fine-grained model parameter controls (temperature, max tokens exposed in UI)
- Monetization/usage limits/billing

**v2 (this pass) — implemented**: user accounts, a persisted story library, and a shared-story feed. See §8 below for goals/success criteria and `docs/adr/0009-accounts-and-persistence-architecture.md` / `docs/adr/0010-shared-story-feed-and-safety.md` for the architecture.

**Still not in scope (deferred beyond this pass)**:

- Facebook OAuth (only Google was built alongside email/password)
- Public/unauthenticated sharing (links, embeds) — the feed is logged-in-Writers-only by design, not a partial step toward public sharing
- Moderation queue/review tooling for reported stories — reports are recorded, not actioned, in this pass
- Comments, likes, follows, or any other social interaction beyond browsing + reporting
- Collaborative multi-user sessions (co-authoring someone else's story, forking)

## 4. Primary users

- **Hobbyist/casual creative writer** — not necessarily technical, wants a fun, fast way to explore a story idea without a blank-page problem. Session-based — comes in, writes/generates a story, may not return with the same session.
- **Parent co-writing with a kid** — uses Fabula as an interactive activity, alternating turns with a child to build a story together. Needs the interface and AI output to be simple and approachable for a non-writer/young audience; no additional technical needs beyond the core flow.

## 5. Core user journey (happy path)

1. User lands on Fabula.
2. User optionally selects a genre/theme, adds starter characters, and/or writes opening lines.
3. User optionally picks an LLM provider/model (default provided if skipped).
4. User optionally sets a target story length, then clicks "Let's write."
   - If opening lines were given, they become the Writer's first paragraph as-is, and the AI's reply streams immediately after.
   - If no opening lines were given, the AI writes the first paragraph itself — inventing a theme/characters and stating its choices first if none were given either.
5. Story canvas shows the growing story. User and AI strictly alternate, one paragraph per turn — after the AI writes, the next paragraph must come from the Writer, and vice versa. Each Writer turn is followed automatically by the AI's reply (one "Continue the Story" click covers both). As the story approaches its target length, the AI increasingly steers its own turns toward a climax and resolution — the target is a soft guide, never a hard stop.
6. Session ends when the tab closes or user manually resets — nothing is saved (v1).

## 6. Success criteria (v1)

- A user with zero input can reach a written first paragraph in under 2 clicks.
- AI-generated paragraphs are perceived as coherent with the given genre/characters/prior text (qualitative review, not automated eval, for v1).
- Switching LLM provider mid-session works without losing story state.
- No server-side persistence of story content beyond the request/response and in-memory session.

## 7. Key risks

- **Model-agnostic adapter complexity**: differing streaming formats, context limits, and prompt conventions across Anthropic/OpenAI/open-weight providers. Mitigate with a single internal `LLMProvider` interface (see AGENTS.md) implemented per provider.
- **Coherence across providers**: switching models mid-story may produce style/tone shifts. Acceptable for v1; not a blocker.
- **Cost control**: no accounts/rate-limiting in v1 means no per-user cost caps. Mitigate with a global reasonable per-request token cap and provider-side spend alerts (manual, not built).

## 8. Goals (v2 — this pass)

- A Writer can create an account (email/password or Google) and sign in; guest (logged-out) use of the core write flow from §5 remains fully available and is never gated behind an account.
- A signed-in Writer's stories are saved automatically as they write — no explicit "save" step — and are listed in a personal library they can return to and resume across sessions/devices.
- A signed-in Writer can mark a story as shared, making it visible read-only to other signed-in Writers in a browsable feed; unsharing removes it from the feed again.
- The feed is visible only to signed-in Writers, not the public — see `docs/adr/0010-shared-story-feed-and-safety.md` for why.
- Shared stories carry a visible disclaimer that content is unmoderated human-written text, and any signed-in Writer can report a shared story with one action (no moderation queue processes reports in this pass — that's a named, deferred gap, not an oversight).

**Success criteria (v2)**:

- Signing up, signing in (both methods), and signing out all work end-to-end against a real deployment.
- A story started while signed in survives a closed tab and reappears, paragraphs intact, when the Writer returns to their library.
- A story started as a guest and then signed into mid-story is not lost — the existing paragraphs persist once the Writer has an account attached, without a separate manual "import" step.
- Toggling sharing on makes a story appear in `/feed` for a different signed-in account; toggling it off removes it. `/library` and `/feed` are unreachable while signed out (redirect to `/login`).
- Reporting a story succeeds once per Writer per story; a second report from the same Writer is a no-op, not a duplicate or an error.
