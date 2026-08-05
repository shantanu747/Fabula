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
2. System clears session story state (no persistence to lose — v1 is session-only).
**Postcondition:** Writer back at the start screen (UC-1/2/3 entry point).

### UC-8: Session ends (tab closed / browser refresh)
**Actor:** System
**Precondition:** Story in progress.
**Flow:**
1. Writer closes tab or refreshes without an in-app save mechanism (none exists in v1).
2. Story state is lost — expected v1 behavior.
**Postcondition:** N/A. (v2: this is where persistence would hook in.)

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