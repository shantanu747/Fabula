# Fabula — Use Cases & User Stories

## Actors

- **Writer** — either persona from the PRD (hobbyist or parent+kid); functionally identical for v1 (no accounts to differentiate them).
- **AI** — the selected LLM provider generating story text.
- **System** — Fabula app logic (session state, provider adapter, streaming).

## Use Cases

### UC-1: Start a story with full input
**Actor:** Writer
**Precondition:** New session, no story started.
**Flow:**
1. Writer enters genre/theme, starter characters, and opening lines.
2. Writer selects LLM provider/model (or leaves default).
3. Writer clicks "I'll write the first paragraph."
4. System creates a new session with the given inputs as story metadata; story canvas is empty, ready for Writer's text.
**Postcondition:** Session holds theme, characters, provider choice; no AI-generated text yet.

### UC-2: Start a story with full input, AI writes first paragraph
**Actor:** Writer, AI
**Precondition:** New session, no story started.
**Flow:**
1. Writer enters genre/theme, starter characters, opening lines.
2. Writer selects provider (or default).
3. Writer clicks "Get me started."
4. System sends theme/characters/lines to the selected provider, streams back a first paragraph.
5. Paragraph appears in the story canvas as AI-attributed text.
**Postcondition:** Session holds initial inputs + one AI-generated paragraph.

### UC-3: Start a story with no input (AI invents everything)
**Actor:** Writer, AI
**Precondition:** New session, no theme/characters/lines provided.
**Flow:**
1. Writer clicks "Get me started" without filling in any fields.
2. System prompts the provider to invent a genre, characters, and an opening, and generate the first paragraph.
3. System displays the AI's invented theme/characters (e.g., as a small header/tag above the canvas) plus the generated paragraph.
**Postcondition:** Session holds AI-invented metadata + first paragraph.
**Note:** Writer cannot click "I'll write the first paragraph" with zero input and expect the AI to invent theme first — if Writer wants to write themselves, some starting context is needed. See US-6 for handling this.

### UC-4: Continue the story (Writer's turn)
**Actor:** Writer
**Precondition:** Story is empty, or the last paragraph was AI-authored (strict one-turn-each policy — the Writer cannot add two paragraphs in a row).
**Flow:**
1. Writer types a new paragraph in the input area.
2. Writer submits.
3. System appends it to the story canvas, attributed to Writer.
**Postcondition:** Story canvas has one more paragraph.

### UC-5: Continue the story (AI's turn)
**Actor:** Writer, AI
**Precondition:** Story is empty, or the last paragraph was Writer-authored (strict one-turn-each policy — the AI cannot generate two paragraphs in a row). Enforced server-side by the `/api/generate` route, not just a client-side UI gate.
**Flow:**
1. Writer clicks "Continue" (AI-generate next paragraph).
2. System sends full story-so-far (or a windowed/summarized version, per context-length constraints) to the selected provider.
3. Provider streams back the next paragraph.
4. System appends it, attributed to AI + provider/model used.
**Postcondition:** Story canvas has one more AI-authored paragraph.

### UC-6: Switch LLM provider mid-story
**Actor:** Writer
**Precondition:** Story in progress.
**Flow:**
1. Writer opens provider/model selector.
2. Writer picks a different provider.
3. Next AI-generated paragraph uses the new provider; prior paragraphs are unaffected and remain in story history regardless of which provider wrote them.
**Postcondition:** Session's "current provider" updated; story history preserved with per-paragraph provider attribution.

### UC-7: Reset / start a new story
**Actor:** Writer
**Precondition:** Any state.
**Flow:**
1. Writer clicks "New story" / reset.
2. System clears session story state. If the story had been saved (signed-in Writer), the saved copy in the library is untouched — reset only clears the in-progress client state, it does not delete anything.
**Postcondition:** Writer back at the start screen (UC-1/2/3 entry point).

### UC-8: Session ends (tab closed / browser refresh)
**Actor:** System
**Precondition:** Story in progress.
**Flow:**
1. Writer closes tab or refreshes without navigating away first.
2. If the Writer was signed in and the story had reached at least one persisted turn, the story is recoverable from `/library` — paragraphs up through the last completed turn are saved (see UC-10).
3. If the Writer was a guest (not signed in), story state is lost — expected behavior, unchanged from v1.
**Postcondition:** N/A for guests. For signed-in Writers, the story is resumable per UC-10.

### UC-9: Sign up / sign in
**Actor:** Writer
**Precondition:** Any state; signing in is always optional, never required to reach UC-1 through UC-8.
**Flow:**
1. Writer clicks "Sign up" or "Sign in" from the header.
2. Writer either fills in name/email/password (signup) or email/password (login), or clicks "Continue with Google."
3. System creates or authenticates the account and establishes a session.
**Postcondition:** Writer is signed in; header now shows their name, a link to their library, and sign out. Nothing about the guest write flow changes for a Writer who chooses not to do this.

### UC-10: Save & resume a story
**Actor:** Writer (signed in)
**Precondition:** Writer is signed in and has written or generated at least one turn in a story (including a story started before signing in — see note).
**Flow:**
1. On the Writer's first turn while signed in, System creates a saved story record and begins persisting each new paragraph as it's completed (Writer's and AI's), with no explicit "save" action.
2. Writer navigates away, closes the tab, or later visits `/library`.
3. Writer clicks a story in their library.
4. System loads the saved story's full paragraph history, theme/characters, and settings back into the story canvas at the point it left off.
**Postcondition:** Writer can continue the story exactly as if they'd never left.
**Note:** A story begun as a guest and continued after signing in mid-story is not lost — the entire pre-signin paragraph history is persisted in one shot on that first signed-in turn, with no separate "adopt this story" step.

### UC-11: Share / unshare a story
**Actor:** Writer (signed in)
**Precondition:** Writer has a saved story (per UC-10).
**Flow:**
1. From `/library`, Writer toggles "Share" on a story.
2. System marks the story as shared; it now appears in the shared feed (UC-12) for other signed-in Writers, attributed to this Writer.
3. Writer can toggle "Share" off at any time, immediately removing it from the feed.
**Postcondition:** Story's shared state reflects the toggle; reversible at any time.

### UC-12: Browse the shared feed
**Actor:** Writer (signed in)
**Precondition:** Writer is signed in. Signed-out visitors are redirected to sign in.
**Flow:**
1. Writer navigates to the feed.
2. System shows a paginated list of shared stories from all Writers, each with a visible disclaimer that shared content is unmoderated human-written text.
3. Writer opens one to read it read-only, with per-paragraph author attribution (Writer name or AI).
**Postcondition:** Writer has read a shared story; no interaction beyond reading and reporting (UC-13) exists in this pass.

### UC-13: Report a shared story
**Actor:** Writer (signed in)
**Precondition:** Viewing a shared story (UC-12).
**Flow:**
1. Writer clicks "Report" on the story.
2. System records the report, associated with this Writer and this story.
3. A repeat report from the same Writer on the same story is a no-op, not a duplicate or an error.
**Postcondition:** Report is recorded. No moderation queue processes it in this pass — this is an explicit, named gap, not an oversight (see `docs/adr/0010-shared-story-feed-and-safety.md`).

## User Stories

- **US-1**: As a Writer, I want to give a genre, characters, and opening lines, so the AI's contributions match the story I have in mind.
- **US-2**: As a Writer, I want to skip all input and just start, so I can explore ideas without upfront effort.
- **US-3**: As a Writer, I want to choose whether I or the AI writes the first paragraph, so I stay in control of the story's origin.
- **US-4**: As a Writer, I want to pick which LLM powers the AI's turns, so I can compare styles/cost/quality across providers.
- **US-5**: As a Writer, I want AI paragraphs to stream in rather than appear all at once, so the experience feels responsive.
- **US-6**: As a Writer with zero input who wants to write the first paragraph myself, I want the system to either let me write into a blank/open scene or nudge me to add at least a theme, so I'm not stuck facing a truly blank page with no guardrails. *(Design decision needed — see Open Question below.)*
- **US-7**: As a parent co-writing with my kid, I want AI-generated content to stay age-appropriate by default, so I don't have to pre-screen every AI turn.
- **US-8**: As a Writer, I want my story to persist for my current session (e.g., surviving a component re-render or navigating within the app), but I understand it will not survive a closed tab in v1.
- **US-9**: As a Writer, I want to see which provider/model generated each AI paragraph, so I can track quality differences as I switch providers.

## Open Question (needs your call before mockup/spec)

**US-6 conflict**: If Writer picks "I'll write the first paragraph" with zero theme/character/input, what happens?
- **Option A**: Let them write into a completely blank canvas, no theme required ever.
- **Option B**: Require at least a theme/genre (can be a quick single click from presets) before "I'll write" is enabled, AI-only path can skip it entirely.
- **Option C**: Writer can start blank; system silently has no "theme" metadata and that's fine — theme is optional context for AI, not a hard prerequisite for anyone.

My default assumption for the spec (unless you say otherwise): **Option C** — theme/characters/lines are always optional hints for the AI, never a gate for the human. Simpler mental model, no forced steps.