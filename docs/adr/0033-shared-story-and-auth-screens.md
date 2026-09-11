# 33. Shared story as a printed piece, and the auth screens

## Status

Accepted.

## Context

Phase 5 of the visual redesign sets the read-only shared story (`/feed/[id]`) as a finished
printed piece with a centered masthead, a drop cap and footer attribution (handoff README
"Shared story", board 1e), and finishes the sign-in / sign-up screens (board 1f). Three
questions the handoff left open are settled here.

## Decision

**No title column; the theme stands in.** The handoff asks for a decision before building the
screen: add an optional `title` column, or fall back to the theme string. Stories have no title
today and nothing in `docs/PRD.md` asks for one, so the masthead sets the theme in the 42px
Cormorant, then the characters, then "A shared story". Adding a column would be schema and
migration work for a field no flow collects. If a title field ever arrives, this is the one
place that reads it.

**The byline names the model from the registry.** "Written by *Name* with *Model* · *n*
paragraphs" needs a model name a reader recognises. `stories.selectedProviderId` is joined to
`getProviderList()` (server-only, the same registry the API accepts) and split to its short name
("Claude"), the way the canvas labels do. A story whose provider id no longer exists in the
registry reads "with an AI". The genre segment the board shows is omitted: with the theme already
serving as the title it would repeat the line above.

**"Start one like this" goes to the start flow, unprefilled.** Prefilling the new story's theme
and characters from the shared one would mean the start page reading query parameters and
writing them into `StoryContext` on mount — a new state path the handoff does not describe. The
button links to `/`; the copy invites, the flow stays the same. Prefill is a small follow-up if a
use case for it appears.

**Drop cap via `::first-letter`, count as a word.** The first paragraph's cap is the CSS
pseudo-element (Tailwind's `first-letter:` variant), not a split string, so the text node stays
whole for selection, search and assistive tech. The paragraph count sets as a word ("eleven
paragraphs") from the same `numberWord` the start flow uses for the length ruler.

**The e2e attribution assertion follows the copy.** `sharing-feed.spec.ts` checked for
"Shared by Writer A"; it now checks the masthead byline.

## Consequences

- **Bundle budgets re-baselined for the redesign's end state.** `/` grew from 13.8KB to 15.7KB
  gzipped (the five-panel start flow, its ruler and colophon) and `/story` from 13.9KB to 15.4KB
  (three responsive layouts and the arc rail). `budgets.json`'s `_baseline` is the 2026-09-10
  production build of all four routes and each budget is that plus ~10%, rounded — the rule
  ADR 0027 set — rather than the two over-budget numbers being raised on their own. Nothing in
  the growth is a dependency; it is markup and class strings for screens that did not exist.

- The masthead is the only centered layout in the product; nothing else should adopt it.
- Auth screens keep the shared full-width header rather than the board's bare lockup, so a
  signed-out reader can still reach sign-in and account creation from anywhere; the board's
  520px column, 38px title, underline fields and guest-first footer line are all as drawn.
