import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript } from "../helpers/mock";
import { seedRouteCheckpoints } from "../helpers/routes";

// Absorbs scripts/responsive-check.mjs (deleted — see docs/adr/0027) into the
// Playwright harness, which is what lets this reach signed-in /library and
// /feed/[id] and a mid-story /story: the old script only had an anonymous
// `page.goto`, so it could never carry a session. Runs under the mobile,
// tablet, and desktop projects (e2e/playwright.config.ts) — testMatch there
// keeps it out of the plain "chromium" project the journey specs use.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

// AGENTS.md's 44px rule and the platform guidance it cites (Apple/Material)
// is about controls, not prose links — an inline text link mid-sentence is
// legitimately smaller than that and is not a bug. `.tap-target` is how the
// codebase marks a link as "styled like a button" (src/app/globals.css); the
// selector below unions that with element types that are never prose:
// buttons, ARIA buttons, selects, and range inputs (a plain text/radio/
// checkbox input's native size is a different, exempted concern — WCAG 2.5.8
// itself exempts user-agent-styled inputs the author hasn't overridden).
const TAP_TARGET_SELECTOR = '.tap-target, button, [role="button"], select, input[type="range"]';

test.describe("responsive layout", () => {
  test("every page fits its viewport with no horizontal overflow", async ({ browser }) => {
    const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
    try {
      for (const { name, page } of checkpoints) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect.soft(overflow, `${name}: horizontal overflow of ${overflow}px`).toBeLessThanOrEqual(0);
      }
    } finally {
      await cleanup();
    }
  });

  test("every control has a real 44px tap target at mobile width", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only check");

    const { checkpoints, cleanup } = await seedRouteCheckpoints(browser);
    try {
      for (const { name, page } of checkpoints) {
        // Hit-testing rather than reading the box: .tap-target expands a
        // control's touch area with an invisible ::after overlay (see its
        // comment in src/app/globals.css) that getBoundingClientRect can't
        // see but a finger lands on. Probing 20px above/below the center
        // asks the question that matters — does a tap near the control
        // reach it — and catches an overlay a stacking context has covered.
        const smallTargets = await page.evaluate((selector) => {
          const probe = 20;
          return [...document.querySelectorAll(selector)]
            .map((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.height === 0 || rect.width === 0) return null;
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const hits = [y - probe, y, y + probe].filter((probeY) => {
                if (probeY < 0 || probeY > window.innerHeight) return true; // off-screen, not a miss
                const hit = document.elementFromPoint(x, probeY);
                return hit ? el.contains(hit) || hit.contains(el) : false;
              });
              const label = (el.textContent || el.getAttribute("aria-label") || el.tagName)
                .trim()
                .slice(0, 40);
              return hits.length === 3 ? null : { label, h: Math.round(rect.height) };
            })
            .filter((x): x is { label: string; h: number } => x !== null);
        }, TAP_TARGET_SELECTOR);

        expect
          .soft(
            smallTargets,
            `${name}: undersized tap target(s): ${smallTargets
              .map((t) => `"${t.label}" (${t.h}px)`)
              .join(", ")}`
          )
          .toHaveLength(0);
      }
    } finally {
      await cleanup();
    }
  });
});
