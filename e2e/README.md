# E2E suite

Playwright specs against a real `next build`/`next start`, a mock LLM provider, and a local
Postgres/Neon-proxy pair — see the root README's "Developing against a local database" section
for setup and `e2e/global-setup.ts` for what it checks before the suite runs.

`npm run test:e2e` runs the default suite: journey specs (`chromium`), `responsive.spec.ts` and
`accessibility.spec.ts` (mobile/tablet/desktop), and `accessibility.spec.ts` again in dark mode
(mobile-dark/desktop-dark). `visual.spec.ts` is excluded from that run — see below.

## Updating visual regression snapshots

`visual.spec.ts` is pixel-fidelity regression against the redesign
(`docs/plans/v4/08-ui-redesign-followups.md`), checked across fifteen checkpoints
(`e2e/helpers/routes.ts`) on five projects — mobile/tablet/desktop and the mobile-dark/desktop-dark
pair. It's gated behind `E2E_VISUAL=1` (`e2e/playwright.config.ts`) and runs as its own CI job,
separate from `e2e`, since it's slower and a pixel-fidelity failure shouldn't block a behavioral
fix from merging while the design owner reviews whether new pixels are right.

**Snapshots must be generated on CI's own runner, never committed from a local machine.** Font
hinting and subpixel rendering differ enough between macOS and the `ubuntu-latest` runner that a
snapshot taken locally fails CI on anti-aliasing alone — not a real visual difference. The
`toHaveScreenshot` comparison already tolerates a little of that noise
(`maxDiffPixelRatio: 0.01`), but not a whole different rendering platform's worth.

To update baselines after an intentional visual change:

1. Push the branch, then dispatch the **"Update visual snapshots"** workflow
   (`.github/workflows/visual-snapshots.yml`) from the Actions tab (or `gh workflow run`) against
   that branch.
2. It runs `npm run test:e2e:visual:update`, which regenerates every `.png` under
   `e2e/specs/visual.spec.ts-snapshots/` (or wherever Playwright places platform-specific
   snapshots — see that directory's own subfolder-per-project layout), and uploads the updated
   tree as a workflow artifact.
3. Download the artifact, extract it over `e2e/specs/`, review the diffs (a snapshot binary diff
   tool, or just look at the PNGs), and commit the ones that are actually the intended change.
4. Push the commit and let the `visual` CI job run against it to confirm the new baselines are
   stable — see "Before calling the job done" below.

## Before calling the visual job done

Run it (`npm run test:e2e:visual`, or the CI job) **twice with no further changes** and confirm
both runs pass. A snapshot suite that flakes against its own anti-aliasing is worse than no
snapshot suite at all — it trains everyone to re-run first and look second.

## Diagnosing e2e flakiness

See `AGENTS.md`'s "Diagnosing e2e flakiness" section and ADR 0020: don't trust `[WebServer]`-log
line order as evidence of causation, and confirm a fix with `npm run test:e2e:soak` (or a targeted
`--repeat-each` loop on the specific specs), not a single clean run.
