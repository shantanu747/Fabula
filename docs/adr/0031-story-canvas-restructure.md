# 31. Story canvas restructure: gutter attribution, arc rail, and what left the canvas

## Status

Accepted.

## Context

Phase 3 of the visual redesign turns the story canvas (`src/app/story/page.tsx`) from a stack of
chat cards into one continuous justified column with authorship in a left gutter and a
vertical "arc" rail on the right (handoff README "Story canvas", boards 1c / 1d / 1g). Most of
it is a straight transcription. Five points were not.

## Decision

**The target-length slider leaves the canvas.** The boards show no length control mid-story,
and the README fixes canvas state as "unchanged" while describing the rail as derived from
`paragraphs.length / targetLength`. Neither `docs/PRD.md` nor `docs/use-cases.md` requires
adjusting the target after the story starts; the PRD calls it "a soft guide". Length is chosen
on the start page and read back on the canvas as "n of ~target" in the rail (desktop) or the
header (below the desktop breakpoint). `e2e/specs/resume-story.spec.ts` read the slider's value
on the canvas to prove the target survives a resume; it now reads it on the start page and
asserts the rail's text after resume — the same guarantee, from the place the value now shows.

**Save and Share in the header are links, not new state.** The boards put `Save` and `Share`
next to `New story`. Persistence for a signed-in Writer is already automatic (ADR 0009), and
sharing already has a toggle in the library. So: a guest's `Save` goes to sign-in with a
callback to `/story` (the guest-adoption path then keeps the paragraphs); a signed-in Writer sees
a static "Saved" once a `storyId` exists; `Share` goes to the library (or to sign-in with the
library as callback). No `isShared` is added to `StoryContext`.

**Rail, gutter rule and progress bar are drawn with SVG attributes and utility classes, never
inline styles.** The production CSP has no `'unsafe-inline'` for `style-src-attr` (ADR 0024), so
`style={{ height }}` on a server-rendered element is a violation. The rail's fill and the mobile
progress bar are `<rect>` heights and widths; the gutter rule and caret bars are positioned
utility spans. The composer's auto-grow sets `el.style.height` through the CSSOM after
hydration, which CSP permits, with `field-sizing: content` doing the same natively where
supported.

**The composer dims, but its label does not.** The README dims the whole composer row to 0.42
during streaming. axe folds ancestor opacity into its contrast computation, so a dimmed "You"
label would fail the accessibility gate on the mid-generation checkpoint. The textarea and its
caret bar dim; the gutter label stays at `--muted`. The visual intent (the Writer's turn is
closed) survives; the label is the one thing that must remain readable.

**Copy: `Continue the Story` becomes `Add & continue`.** Four e2e specs and the shared
`writeParagraph` helper selected the button by its old name and were updated together with the
copy. The PRD's prose still says "Continue the Story" as a description of the action, not as UI
text.

**Header actions fold into a footer nav on a phone.** Board 1g's 52px header carries only the
mark, the theme and the count; `Save` / `Share` / `New story` and the auth links repeat in a
`<nav>` under the action row instead of a menu (menus are not in the design and would be new
scope). `New story` therefore exists twice in the DOM; only one is rendered at any width, and
role queries skip the hidden one.

## Consequences

- A Writer who wants to change the target mid-story now starts over or accepts the guide. If a
  use case for mid-story adjustment appears, the rail is the natural place to put a control.
- `#target-length` exists only on the start page. Anything that reads it on `/story` breaks.
- The canvas has three layouts (phone, tablet with gutter and bar, desktop with gutter and rail)
  and the responsive e2e spec covers all three viewports.
