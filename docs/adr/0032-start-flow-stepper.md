# 32. Start flow as a five-step slide

## Status

Accepted.

## Context

Phase 4 of the visual redesign replaces the single scrolling start page with five screens on a
sliding track (`docs/design/handoff.md` "Start flow", board 2a): scene, people, opening, voice, length.
Everything remains optional; the story state in `StoryContext` is untouched; the only new state
is which screen is up. The mechanics below are where the implementation had to choose.

## Decision

**Off-stage panels are `inert` and `aria-hidden`.** The track holds all five panels at once and
slides them with `transform`, so without this a keyboard user could tab into a field they cannot
see, and a screen reader would read five screens as one. React 19 supports the `inert` boolean
directly. After each slide, focus moves to the new panel (a `tabIndex={-1}` section labelled by
its title) so the change is announced and the next Tab lands inside it.

**The slide is five static classes, not an inline transform.** `translate-x-0` through
`-translate-x-4/5` are chosen by index. An inline `style` on a server-rendered element violates
the production CSP (ADR 0024). `motion-reduce:transition-none` honours reduced motion by dropping
to an instant switch, one of the two options the handoff allows.

**The ruler keeps the native range and its 1-paragraph step.** Thirteen rules stand for the even
values 6–30 as a scale; the transparent full-size `<input type="range">` over them stays the
actual control, so pointer, keyboard and assistive tech all drive one value and odd targets a
saved story may carry still round-trip. Rules light up to the nearest value at or below the
target. On keyboard focus the native input becomes visible so the focus ring has something to
sit on.

**e2e reaches fields through the rail.** `startStory` in `e2e/helpers/story.ts` now walks to a
field's step before filling it, `goToStartStep` exposes that walk, and `beginStory` is the last
step's forward action ("Begin the story", replacing "Let's write"). Playwright's actionability
checks refuse an `inert` element, which is the right failure: a spec that fills a field the
Writer cannot see is asserting something the product does not do. For the same reason the
responsive spec's tap-target probe skips controls inside an `inert` subtree: they are not
tappable, and probing them measures only where the slide left them.

**On a phone the footer wraps.** Board 2a is a desktop board; five rail items plus Back and the
forward action do not fit in 390px on one row. The rail takes its own row above, Back and the
forward action share the row below. The stage keeps a 472px minimum but grows with the tallest
panel rather than clipping, since the provider rows and the colophon both exceed it at that
width.

## Consequences

- `#target-length` lives on the fifth step only; anything reading it must go there first.
- The "let the AI write the first paragraph" link clears the opening lines and advances — the
  same US-6 resolution as before (the AI opens when there is nothing to open with), now
  spelled out on the screen where the choice is made.
- The `/` route's first-load JS changes with the rewrite; its budget is re-measured with the
  other routes at the end of the redesign (ADR 0027's rule: baseline and budget move together).
