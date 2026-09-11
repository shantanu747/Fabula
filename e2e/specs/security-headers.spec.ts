import { test, expect, type Page } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse, errorResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { startStory, waitForAiParagraph, errorAlert } from "../helpers/story";

// src/proxy.ts, src/lib/security/csp.ts, next.config.ts.

const STATIC_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};

function expectStaticHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(STATIC_HEADERS)) {
    expect(headers[name], `missing/wrong ${name}`).toBe(value);
  }
}

/**
 * Registers a `securitypolicyviolation` listener before any page script runs.
 * `addInitScript` re-installs it on every subsequent navigation in this same
 * `page` (Playwright re-runs init scripts for each new document), so one call
 * up front covers every route a test walks — checked with `expectNoCspViolations`
 * right before moving on, since the array itself is reset by the next navigation.
 */
async function trackCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    window.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
        `${e.violatedDirective} blocked ${e.blockedURI}`
      );
    });
  });
}

async function expectNoCspViolations(page: Page, route: string): Promise<void> {
  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  expect(violations, `CSP violation(s) on ${route}: ${violations.join("; ")}`).toEqual([]);
}

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("static headers and CSP", () => {
  test("sets every static security header and a nonced CSP on the homepage", async ({ page }) => {
    const response = await page.goto("/");
    const headers = response!.headers();

    expectStaticHeaders(headers);
    expect(headers["content-security-policy"]).toMatch(/nonce-[^ ']+/);
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("carries the same headers on the /library -> /login redirect, unauthenticated", async ({ request }) => {
    const response = await request.get("/library", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toBe("/login?callbackUrl=%2Flibrary");
    expectStaticHeaders(response.headers());
    expect(response.headers()["content-security-policy"]).toMatch(/nonce-[^ ']+/);
  });

  test("does not attach a CSP to a static asset response", async ({ request }) => {
    const response = await request.get("/favicon.ico");
    expectStaticHeaders(response.headers());
    expect(response.headers()["content-security-policy"]).toBeUndefined();
  });
});

test.describe("zero CSP violations, signed out", () => {
  test("walks /, /login, /signup, /story (empty and mid-generation), and a 404", async ({ page }) => {
    await trackCspViolations(page);

    await page.goto("/");
    await expectNoCspViolations(page, "/");

    await page.goto("/login");
    await expectNoCspViolations(page, "/login");

    await page.goto("/signup");
    await expectNoCspViolations(page, "/signup");

    await setMockScript(streamResponse(["The lighthouse had not blinked in "], { delayMs: 300 }));
    await startStory(page);
    await expectNoCspViolations(page, "/story (mid-generation)");
    await waitForAiParagraph(page, 1);
    await expectNoCspViolations(page, "/story (settled)");

    await setMockScript(errorResponse(502));
    await page.getByLabel("Write the next paragraph").fill("A reply that will fail.");
    await page.getByRole("button", { name: "Add & continue" }).click();
    await expect(errorAlert(page)).toBeVisible();
    await expectNoCspViolations(page, "/story (error state)");

    await page.goto("/this-route-does-not-exist");
    await expect(page.getByText("There's no story here")).toBeVisible();
    await expectNoCspViolations(page, "404");
  });
});

test.describe("zero CSP violations, signed in", () => {
  test("walks /library, /feed, and /feed/[id]", async ({ page }) => {
    await trackCspViolations(page);

    await signUp(page, uniqueEmail(), { name: "Writer A" });
    await expectNoCspViolations(page, "post-signup");

    await setMockScript(streamResponse(["A shared beginning."]));
    await startStory(page, { theme: "a rooftop garden" });
    await waitForAiParagraph(page, 1);

    await page.getByRole("link", { name: "My library" }).click();
    await expectNoCspViolations(page, "/library");

    // ShareToggle updates its own label optimistically, before the PATCH
    // resolves (src/components/ShareToggle.tsx) — wait on the response
    // itself so the subsequent /feed visit reliably sees the committed share.
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/stories/") && r.request().method() === "PATCH"),
      page.getByRole("button", { name: "Share to feed" }).click(),
    ]);
    await expect(page.getByRole("button", { name: "Shared to feed" })).toBeVisible();

    await page.getByRole("link", { name: "Feed" }).click();
    await expectNoCspViolations(page, "/feed");

    await page.getByRole("link").filter({ hasText: "a rooftop garden" }).click();
    await expect(page).toHaveURL(/\/feed\//);
    await expectNoCspViolations(page, "/feed/[id]");
  });
});
