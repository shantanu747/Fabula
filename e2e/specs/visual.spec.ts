import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript } from "../helpers/mock";
import { seedRouteCheckpoints } from "../helpers/routes";

// Pixel-fidelity regression for the redesign (docs/plans/v4/08-ui-redesign-followups.md).
// Runs on mobile/tablet/desktop (light) and mobile-dark/desktop-dark
// (e2e/playwright.config.ts) — fifteen checkpoints × five projects, which is
// why this is gated behind E2E_VISUAL=1 and kept out of the default `npm run
// test:e2e` run (see the config's comment). Snapshots are generated on CI's
// own ubuntu-latest runner, never committed from a local macOS run: font
// hinting and subpixel rendering differ enough between platforms that a
// snapshot from one fails the other on anti-aliasing alone, not a real
// difference. See e2e/README.md for the update workflow.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("every checkpoint matches its committed baseline", async ({ browser }) => {
  // Playwright's 30s default test timeout is sized for one checkpoint, not
  // fifteen: seedRouteCheckpoints does several signups and generations before
  // this even starts, and each of the fifteen loop iterations below is its
  // own full-page screenshot. Observed to run right up against 30s on a
  // otherwise-idle machine — CI's shared runners are slower, not faster.
  test.setTimeout(180_000);

  const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
  try {
    for (const { name, page } of checkpoints) {
      const mask = [
        // The in-progress paragraph's caret (story-mid-generation): its
        // position shifts with however much of the mocked stream has landed
        // by the time the screenshot is taken, which isn't deterministic.
        page.locator('article[aria-hidden="true"] p span'),
        // The signed-in header's name/email (library, feed, feed-detail,
        // story-with-paragraphs): unique per test run (uniqueEmail()).
        page.getByTestId("session-user"),
      ];
      await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, mask });
    }
  } finally {
    await cleanup();
  }
});
