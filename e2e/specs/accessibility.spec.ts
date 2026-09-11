import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript } from "../helpers/mock";
import { seedRouteCheckpoints } from "../helpers/routes";

// Runs under the mobile/tablet/desktop viewport projects like
// responsive.spec.ts, but the axe scan itself only needs mobile and desktop
// (see the test.skip below) — some violations only appear at one width, and
// tablet wouldn't add a third data point worth the extra run.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("accessibility", () => {
  test("no serious or critical axe violations on any scanned route", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "scanned at mobile and desktop only");

    const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
    try {
      for (const { name, page } of checkpoints) {
        const results = await new AxeBuilder({ page }).analyze();

        const [reportable, blocking] = [
          results.violations.filter((v) => v.impact === "minor" || v.impact === "moderate"),
          results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
        ];

        // Reported but not gated on — a gate that fires on every minor
        // contrast nudge gets disabled within a month (docs/adr/0027).
        for (const violation of reportable) {
          console.log(`[axe:${violation.impact}] ${name}: ${violation.id} — ${violation.help}`);
        }

        const summary = blocking
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`)
          .join("\n");
        expect.soft(blocking, `${name}:\n${summary}`).toHaveLength(0);
      }
    } finally {
      await cleanup();
    }
  });

  // Two decisions axe can't see, because they're deliberate ARIA choices
  // rather than violations of anything — both explained in
  // src/app/story/page.tsx, and only worth testing once (not per-viewport).
  test.describe("story streaming semantics", () => {
    test("the streaming paragraph is aria-hidden while the status line announces", async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "checked once, not per-viewport");

      const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
      try {
        const { page } = checkpoints.find((c) => c.name === "story-mid-generation")!;
        await expect(page.locator('article[aria-hidden="true"]')).toBeVisible();
        await expect(page.getByRole("status")).toHaveText(/is writing a paragraph/);
      } finally {
        await cleanup();
      }
    });

    test("the finished-paragraph log announces politely", async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "checked once, not per-viewport");

      const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
      try {
        const { page } = checkpoints.find((c) => c.name === "story-with-paragraphs")!;
        const log = page.getByRole("log", { name: "Story so far" });
        await expect(log).toHaveAttribute("aria-live", "polite");
      } finally {
        await cleanup();
      }
    });

    // WCAG 2.4.7: the composer is borderless by design (no `.field` underline
    // rule, ADR 0031) and drops the global outline (ADR 0030), so its focus
    // indicator is this one purpose-built device — assert it actually appears
    // on keyboard focus rather than trusting the CSS alone.
    test("the composer shows a focus indicator on keyboard focus", async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "checked once, not per-viewport");

      const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
      try {
        const { page } = checkpoints.find((c) => c.name === "story-empty")!;
        const composer = page.locator("#next-paragraph");
        const focusRule = page.locator("#next-paragraph + span");

        expect(await focusRule.evaluate((el) => getComputedStyle(el).display)).toBe("none");
        await composer.focus();
        expect(await focusRule.evaluate((el) => getComputedStyle(el).display)).toBe("block");
      } finally {
        await cleanup();
      }
    });
  });
});
