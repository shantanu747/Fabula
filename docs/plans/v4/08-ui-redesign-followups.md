# Plan 8 — UI redesign follow-ups

**Branch:** `feature/ui-redesign-followups`
**Depends on:** the `design/redesign` branch (ADRs 0029–0033) being merged. Independent of plans
1–7: no Redis, no schema change, no protocol change. Can run in parallel with any of them.
**ADR:** required for the items marked *decision* below (next unused number at the time of
writing: `0034`); the mechanical items need none.

## Why this exists

The visual redesign is implemented and every CI gate passes on it. Five things are still true
that should not be:

1. **The spec is not in the repo.** ADRs 0029–0033 cite `design_handoff_fabula_redesign/README.md`
   and `classical/styles.css` as the source of truth for every token and component, and that
   folder is in `.gitignore`. A reader of the ADRs on a fresh clone cannot find what they
   reference. `mockups/` meanwhile still holds the *pre*-redesign screens, and the knowledge graph
   has nodes ("Turn Bubble", "Story Thread") extracted from them.
2. **Pixel fidelity is enforced by nobody.** The redesign was checked against the boards by
   screenshots taken in throwaway scripts. Nothing in CI would notice a future change that puts a
   `rounded-lg` back (the class is dead, so it would silently render square — fine) or moves the
   gutter to 100px (not fine, and invisible to every existing gate).
3. **The dark palette is never scanned.** `e2e/specs/accessibility.spec.ts` runs axe in the light
   scheme only. ADR 0029 records that the dark `--accent-text` is the same as `--accent`, and ADR
   0030 notes an interim pair that measured 1.69:1 on dark and was never caught for exactly this
   reason. The accent-on-dark values pass by hand calculation; nothing proves it on every route.
4. **The composer has no visible focus indicator.** It is borderless by design (README "Composer")
   and the underline fields' accent rule, which serves as their focus indicator, was deliberately
   not given to it. A keyboard user tabbing into the story column sees only a caret. That is a
   WCAG 2.4.7 gap the redesign introduced.
5. **Three handoff intents were deliberately deferred**, each with the reason recorded in its ADR,
   and each still open: "Start one like this" does not prefill (ADR 0033); target length cannot be
   changed on the canvas (ADR 0031); "Share" in the canvas header is a link to the library, not a
   toggle (ADR 0031).

Plus two small known bugs and a debt list at the end.

## What "done" means

- The design spec the ADRs cite is committed under `docs/design/`, `mockups/` is gone, and
  `graphify update .` no longer emits nodes for the old screens.
- A visual-regression job exists in CI for the board-equivalent screens at three widths and both
  schemes, with snapshots generated on CI's OS, and a documented way to update them.
- axe runs in both colour schemes on every scanned route.
- The composer has a visible, themed focus indicator and the accessibility spec asserts it.
- Each *decision* item has an ADR that says build, defer, or drop — not a silent omission.
- The feed does not show duplicate rows in development.

## Files

### `docs/design/` (new) — commit the spec

Copy in, verbatim: the handoff `README.md` (as `docs/design/handoff.md`), `classical/styles.css`
and `classical/readme.md` (as `docs/design/classical/`), and the `screenshots/` folder minus the
two `0a`/`0b` "current UI" boards, which are now wrong twice over. The `.dc.html` prototype is
68KB of inline-styled HTML and is the least useful artefact; include it only if the design owner
wants it versioned. Remove the `design_handoff_fabula_redesign/` line from `.gitignore`, then
update the paths in ADRs 0029–0033 (editorial edits to ADRs are permitted for exactly this).

Delete `mockups/`. Nothing in `src/` or `docs/` references it; only the knowledge graph does, and
`graphify update .` after the deletion clears those nodes. If a before/after record is wanted, the
handoff's `0a`/`0b` boards already are one — keep those two instead, under
`docs/design/screenshots/before/`, and say so in the README.

Add one paragraph to `docs/architecture.md` pointing at `docs/design/` and the token layer in
`src/app/globals.css`, so the design system is discoverable from the same place as everything
else. Update `docs/PRD.md` §4 step 4: the button reads "Begin the story", and length is the fifth
step of the start flow.

### `e2e/specs/visual.spec.ts` (new) — visual regression

Playwright's `toHaveScreenshot` against the checkpoints `e2e/helpers/routes.ts` already builds
(home, login, signup, not-found, story-empty, story-with-paragraphs, story-mid-generation,
story-error, library, feed, feed-detail). Add the four remaining start-flow steps by walking the
rail with `goToStartStep` from `e2e/helpers/story.ts`. Run under the existing `mobile`, `tablet`
and `desktop` projects (`e2e/playwright.config.ts`), and add `colorScheme: "dark"` variants of
the desktop and mobile projects — two new project entries, not a new config.

Snapshots are OS-specific: font hinting and subpixel rendering differ between macOS and the
`ubuntu-latest` runner, so a snapshot committed from a Mac fails in CI by a few hundred pixels
of anti-aliasing. Generate them **in CI** — a workflow dispatch that runs `--update-snapshots` and
uploads the result as an artifact, which the author commits — and set `maxDiffPixelRatio` to a
small value (0.01 is a starting point) rather than zero. Document the update flow in
`e2e/README.md` or the spec's header comment. Mask the streaming caret and the auth-header's
user name, which vary by run.

Keep this a separate CI job from `e2e`. It is slower (fifteen checkpoints × five projects), and
a fidelity failure should not block a behavioural fix from merging while the design owner decides
whether the new pixels are right.

### `e2e/specs/accessibility.spec.ts` (modify) — dark scheme

Same scan, `colorScheme: "dark"`. The cheapest route is the two extra projects above, gated by
`testMatch` so the journey specs do not double up. Expect no violations; if the dark
`--muted` (0.55 alpha, 5.27:1 by calculation) or dark `--accent-text` fails, fix the token in
`globals.css`, not the test.

Add one assertion to the "story streaming semantics" group: tab to `#next-paragraph` and check a
computed style that distinguishes focused from unfocused (see next item).

### `src/app/story/page.tsx` + `globals.css` (modify) — composer focus

Give the composer a focus indicator that belongs to the design: the 1.5px accent bar that opens
the empty composer (README "Composer") becomes a 2px accent rule down the left of the textarea
while it has `:focus-visible`, regardless of content — the same device the AI gutter rule uses,
in the composer's own column. Do not restore the global outline; ADR 0030 explains why it was
layered beneath `.field`. Implement as a `peer` sibling or a `focus-within:` on the wrapper —
never an inline style (CSP, ADR 0024).

### `src/app/feed/page.tsx` (modify) — duplicate rows in development

`useEffect(() => { fetchPage(0); }, [])` runs twice under React strict mode in `next dev`, and
`setStories((prev) => [...prev, ...data.stories])` appends both results. Production is unaffected
(one mount, one fetch), which is why no test catches it. Fix by keying on offset — ignore a
response for an offset already merged — or by de-duplicating on `story.id` in the reducer.
Prefer the former: it also protects the "Load more" path against a double click. Plan 3 replaces
this page with a server-rendered feed; if that has merged first, this item is moot.

### *Decision:* "Start one like this" prefill — `src/app/page.tsx`, `feed/[id]/page.tsx`

The button links to `/` with nothing carried over (ADR 0033). Prefilling means the start page
reads `?theme=` and `?characters=` on mount and dispatches into `StoryContext` when the fields are
empty — a new input path into client state, and one that lands on step one with the theme already
filled, which the five-step flow was designed to avoid. Either build it as a `startFrom` search
param handled once in `Home` (with `MAX_HINT_LENGTH` applied, since it is user-controlled input),
or change the copy to "Start a story", which the link actually does. Write the ADR either way.

### *Decision:* target length on the canvas — `src/app/story/page.tsx`

ADR 0031 removed the slider because the boards show none and no use case needs it. If the
product wants it back, the arc rail is the place: the rail's track is already a 210px scale, and
a visually hidden `<input type="range">` driving it — the same pattern step five uses — keeps the
board and restores the control. Do not add a second visible slider. Otherwise, close the item
with a one-line ADR amendment and delete the `setTargetLength` import that `StoryContext` still
exports for this page's benefit.

### *Decision:* Share from the canvas — `src/app/story/page.tsx`, `src/lib/story/`

The header's "Share" is a link to the library (ADR 0031), because `StoryContext` has no
`isShared` and adding one was out of the redesign's scope. Making it a toggle means: `isShared`
in `StoryState`, hydrated from `GET /api/stories/:id` (which already returns it) and set by the
`PATCH` `ShareToggle` already sends; a guest sees the same "Sign in to save" as now. This is a
real, small feature — it touches `src/lib/story/**`, which is held at 100% coverage — so it needs
the reducer case tested. Decide with the product owner whether sharing from mid-story is wanted
before building it.

### Debt, no decision needed

- **Pure UI helpers are untested.** `splitDisplayName`, `numberWord` and the canvas's
  `stageIndex` live under `src/components/` precisely because `src/lib/**` is coverage-gated.
  Move them to `src/lib/ui/` with unit tests and pick the coverage tier deliberately (rule 7 in
  the v4 README). `stageIndex` has four boundaries; test each.
- **Tablet header crowding.** At 768–900px the canvas header holds mark, divider, theme, count,
  Saved, Share, New story, My library, Feed, Sign out; the theme truncates to a few words. Hide
  the user name (already done) and consider hiding "Saved" below `lg`. Cosmetic; no board covers
  this width.
- **Print stylesheet for the shared story.** It is set as a printed piece; a `@media print` block
  that drops the header, footer actions and Report, and lets the masthead and prose fill the page,
  is a few lines in `globals.css`.
- **The `Mark` component's `compact` and `display` sizes are unused.** Either use `display` on a
  future about/landing surface or delete the two entries; dead variants invite drift.
- **`--shadow-whisper` is declared and unused.** Fine by design (README "Shadows"); leave it, but
  do not let a second shadow token appear next to it.

## Tests

- `e2e/specs/visual.spec.ts`: one test per project, looping the checkpoints, `expect(page)
  .toHaveScreenshot(\`${name}.png\`, { fullPage: true, mask: [...] })`.
- `accessibility.spec.ts`: the dark-scheme projects; the composer focus assertion.
- Unit tests for the moved helpers.
- If the Share toggle is built: a `StoryContext` reducer test for `SET_SHARED`, and an e2e
  assertion in `sharing-feed.spec.ts` that toggling from the canvas shows the story in another
  account's feed — the existing library-based test stays.

## Verification

Everything in the v4 README's rule 3, plus the new visual job, plus `npm run bundle-budget` after
`rm -rf .next` (the focus-indicator and prefill changes touch `/` and `/story`, both re-baselined
on 2026-09-10 with ~10% headroom; a few hundred bytes fit, a new dependency does not).

Before calling the visual job done, run it twice on CI without changes and confirm both pass;
a snapshot suite that flakes on its own anti-aliasing is worse than none.

## Gotchas

- Do not start a dev server on port 3111. `e2e/playwright.config.ts` reuses any server it finds
  there outside CI, and the suite then runs against the wrong database and no mock provider.
- `next dev` and `next typegen` both write `.next/types`; run concurrently on macOS they leave
  `routes.d 2.ts` duplicates and typecheck fails with "Duplicate identifier 'LayoutProps'". Stop
  the dev server before `npm run typecheck` or `npm run build`.
- Inline `style` attributes on server-rendered elements violate the production CSP
  (`style-src-attr`). Dynamic heights and transforms are SVG attributes or static classes; only
  CSSOM writes after hydration are allowed (ADR 0031, ADR 0032).
- axe folds ancestor opacity into contrast and evaluates an empty textarea's colour. Dim
  placeholders, never controls (ADR 0031).
- The tap-target probe in `responsive.spec.ts` skips `[inert]` subtrees; keep off-stage stepper
  panels inert or that probe measures where the slide left them (ADR 0032).

## Out of scope

- A user-facing light/dark toggle. The handoff specifies `prefers-color-scheme` only.
- A `title` column for stories (ADR 0033 chose the theme as the masthead title).
- Icons. The design uses none; if one is ever needed the system specifies Lucide at hairline
  weight.
- Any new page or surface. This plan finishes the redesign; it does not extend it.

## ADRs

One per *decision* item above, each in the Status / Context / Decision / Consequences format, plus
the editorial path fixes to ADRs 0029–0033 once the spec moves into `docs/design/`.
