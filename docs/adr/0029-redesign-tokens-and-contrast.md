# 29. Redesign tokens: measured contrast over the handoff's claimed numbers, and locked theme namespaces

## Status

Accepted.

## Context

The visual redesign (`design_handoff_fabula_redesign/`) replaces the palette, fonts and radius
in `src/app/globals.css` with the Classical design system's tokens. Its README states a contrast
ratio next to each color and asks that the existing accessibility work be carried forward
unchanged. `e2e/specs/accessibility.spec.ts` (ADR 0027) enforces that with axe at the
serious/critical level on every route, and `color-contrast` is a serious rule.

Applying the handoff's tokens verbatim failed that spec on every route, with 123 nodes across
two distinct causes:

1. **`--muted` as specified does not meet AA.** The handoff gives `rgba(32,31,29,0.55)` on the
   `#f3f2f2` ground and annotates it "4.9:1". Compositing 0.55 of `#201f1d` over `#f3f2f2`
   yields `#7f7e7d`, which axe measures at **3.62:1**. The claimed figure is wrong (it is close
   to what `--accent-text` actually measures, 4.88:1, so it may have been transposed). The
   previous palette had already been through exactly this correction once — ADR 0027 darkened
   the old `--muted` from `#83786a` to `#766c60` after measuring 3.79–4.32.

2. **`text-accent` on paragraph-size links.** Three inline links (`Create an account`,
   `Sign in`, and the library's empty-state link) used the accent as text color at 12–14px.
   `#b68235` is 3.02:1 on the ground. The handoff is explicit that `--accent` is chrome-only and
   introduces `--accent-text` (`#8a6224`) for exactly this case; the links predate the token.

A separate, non-contrast decision came up while wiring the tokens into Tailwind v4's `@theme`:
whether to *add* the design-system roles next to Tailwind's stock palette, fonts, radii and
shadows, or to *replace* those namespaces.

## Decision

**`--muted` sets at `rgba(32,31,29,0.66)` on light.** That composites to `#686765`, 5.06:1 on
the ground — the same "clear AA with margin" bar ADR 0027 chose, so a future ground tweak of a
few percent doesn't drop it back under 4.5. The dark value stays at the handoff's 0.55
(`#8d8c89` on `#191817` measures 5.27:1; no correction needed). Alpha rather than a solid hex is
kept because it is the handoff's mechanism for one token sitting correctly on the single ground.

**Inline accent-colored text uses `text-accent-text`.** The three links were switched as part of
the token change rather than deferred to the component-migration phase, because the token change
alone is what made the spec fail, and the repo rule is that a change is not complete until the
CI gates pass on the working tree.

**Tailwind's stock namespaces are cleared, not extended.** `@theme inline` sets `--color-*`,
`--font-*`, `--radius-*` and `--shadow-*` to `initial` before declaring the design system's
roles. Consequences of that choice, all intended:

- `bg-white`, `text-gray-500`, `text-red-600`, `shadow-sm`, `rounded-2xl`, `font-sans`,
  `font-mono` and the rest stop generating CSS. A class that isn't in the system silently does
  nothing rather than silently drifting the page toward a filled card or a sans-serif label.
  The two existing `text-red-600` error labels fall back to the foreground color; the redesign's
  error state is a plain ruled block with no tint, so this is the intended end state, not a
  regression to fix later.
- `rounded` (bare) is the only radius utility and resolves to the `--radius: 4px` token. The
  chips' 3px is written as `rounded-[3px]`; circles use `rounded-full`, which is static.
- `--font-heading` and `--font-body` are the only font utilities. The `next/font` CSS variables
  are named `--font-cormorant` / `--font-lora` (not `--font-heading` / `--font-body` as the
  handoff's snippet shows) because a theme key that references a same-named variable under
  `@theme inline` emits a self-referencing `var()`. `--default-font-family` and
  `--default-mono-font-family` both point at the body face so preflight's `html` and
  `code`/`kbd`/`pre` rules cannot reintroduce a system sans or mono.

**Two tokens exist that the handoff's table does not list.** `--prose` (`#201f1d` light,
`#e6e3de` dark) carries the handoff's "prose sets at `#e6e3de`" note as a token rather than a
hard-coded value in the story column. `--shadow-whisper` is the one shadow the system allows,
exposed so the arbitrary-value escape hatch is never needed if it is ever called for.

## Consequences

- The muted grey is visibly a step darker than the prototype screenshots. That is the cost of
  AA; the handoff's own accessibility section ranks that above visual match.
- Any future palette change must be checked by measurement (axe, or the contrast script in the
  session that produced this ADR), not by the numbers written next to a token. Both palette
  passes this repo has had shipped with an incorrect annotation.
- Introducing a new color, radius or shadow means adding a token in `globals.css` first. That
  is a deliberate friction: it is the mechanism that keeps the "no fills, hairlines only, 4px
  everywhere" rules enforced by the build rather than by review.
- Interim state during the phased migration: filled `bg-accent` buttons still exist until the
  component phase replaces them with outlines. Their `text-accent-foreground` no longer resolves,
  so they render ink on gold (4.89:1 light). On dark that pair is 1.69:1, which axe does not scan
  (light scheme only) — it is a known, short-lived gap closed by the outline migration, not a
  state to ship.
