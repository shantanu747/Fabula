# 30. Redesign atoms: outlined buttons, underline fields, chips, and the two-voices mark

## Status

Accepted.

## Context

Phase 2 of the visual redesign (`docs/design/handoff.md`, "Component specs")
replaces every filled button, boxed input, and pill in the codebase with the Classical system's
atoms: a 1px-stroke button on transparent, a bottom-rule-only field, a 3px-radius chip, and an
inline SVG mark. Four choices along the way were not straightforward transcriptions of the spec.

## Decision

**Atoms are CSS classes in `globals.css`'s `@layer components`, not React components.** `.btn`
with `.btn-primary` / `.btn-secondary` / `.btn-text` and size steps, `.field`, `.field-label`,
`.kicker`, `.chip`, `.radio` + `.dot`, `.author-label`. The handoff writes the states as CSS
(`color-mix()` hover and active tints); a class layer carries them verbatim and applies equally
to `<button>`, `<a>`, and `next/link`, which a `Button` component would have to special-case.
Utilities still win for one-off sizes because Tailwind emits its utilities layer last. Base
styles (body, focus ring, selection, caret, disabled) moved into `@layer base` for the same
reason: an unlayered rule beats every layered one, and the global focus outline was drawing a box
around the underline fields until it was layered beneath `.field:focus-visible`.

**Primary button labels use `--accent-text`, not `--accent`.** The spec's table gives the label
as `var(--accent)`. At 16px semibold that is paragraph-size to WCAG (bold means ≥700), so 3.0:1
fails the axe gate on every primary action. The stroke stays `--accent`; only the label steps to
`--accent-text`. The same rule was applied to the chip's resting text (spec 0.62 alpha, 4.49:1;
uses `--muted`), the writer author label (spec 0.50), and the Report text button (spec 0.42) —
every one of these is text, and every one lands on `--muted` (5.06:1). Placeholders keep the
spec's 0.34 alpha: they are not DOM text and axe does not evaluate them.

**Chips are a 44px button around a 33px visual.** The handoff wants chips visually ~33px tall
and also asks that the 44px touch target survive. `.tap-target`'s overlay is unsafe on a wrapping
row (its comment in `globals.css` explains why), so the chip is a transparent `min-height: 44px`
button whose inner `<span>` draws the hairline. `aria-pressed` carries the selected state, which
the previous chips never exposed.

**`favicon.ico` is regenerated, not replaced by `icon.svg` alone.** The handoff asks for an SVG
favicon. `src/app/icon.svg` is added, and `favicon.ico` is rebuilt from it (a 32px PNG in an ICO
container, rendered with the `sharp` already in `node_modules`) rather than deleted: the proxy's
CSP matcher excludes `/favicon.ico` by name and `e2e/specs/security-headers.spec.ts` requests it
to prove static assets carry no CSP. Keeping the route means neither the security config nor
its test changes for a cosmetic swap, and Safari (no SVG favicon support) shows the same mark.

**Header label.** "Sign up" becomes "Create an account" per the spec's header. No test selected
it by that text.

## Consequences

- No `bg-accent`, `bg-card`, `bg-ai`, `shadow-*`, `rounded-xl/2xl/full`-on-pills, or
  `text-accent-foreground` remains in `src/`. Filled surfaces cannot come back without adding a
  token (ADR 0029).
- The story canvas, start page, shared story, and auth pages are reskinned but not yet
  restructured (gutter, arc rail, stepper, masthead are phases 3–5). The start page follows board
  `1b`, the single-page precursor to the `2a` stepper, so nothing here is thrown away later.
- Screens outside the handoff's boards (feed list, library, error, not-found, loading) follow the
  same atoms and hairline rows; there is no board to match pixel-for-pixel, so they are judged
  against the system rules rather than a screenshot.
