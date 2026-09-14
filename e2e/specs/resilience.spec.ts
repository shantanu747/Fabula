import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { paragraphArticles, startStory, waitForAiParagraph } from "../helpers/story";

// docs/adr/0044-durable-writer-turns-and-idempotent-creation.md.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a submitted Writer paragraph survives even when the AI's reply never arrives", async ({ page, browser }) => {
  await signUp(page, uniqueEmail());

  // /api/generate is left hanging — standing in for "the tab closes, or the
  // connection drops, before generation finishes." Persist-on-submit's whole
  // point is that the Writer's own paragraph doesn't depend on this ever
  // resolving; deliberately never calling route.continue/fulfill/abort leaves
  // the request pending for the rest of this test.
  await page.route("**/api/generate", () => {});

  await startStory(page, { theme: "a stranded expedition", openingLines: "The radio went silent at dawn." });
  // No waitForAiParagraph — the AI's turn is intentionally never given the
  // chance to complete. Waiting for the persist-on-submit request itself is
  // what this test is actually about.
  await page.waitForResponse(
    (r) => r.url().includes("/paragraphs") && r.request().method() === "POST" && r.ok()
  );

  // A fresh context, not this tab reloaded — /story's hydration effect only
  // fires when the requested storyId differs from client state, which is
  // never true for this tab once it has created the story (see
  // resume-story.spec.ts's identical reasoning).
  const storageState = await page.context().storageState();
  const freshContext = await browser.newContext({ storageState });
  const freshPage = await freshContext.newPage();

  await freshPage.goto("/library");
  await freshPage.getByRole("link", { name: /a stranded expedition/ }).click();
  await freshPage.waitForURL(/\/story\?storyId=/);

  await expect(paragraphArticles(freshPage)).toHaveCount(1);
  await expect(paragraphArticles(freshPage).nth(0)).toContainText("The radio went silent at dawn.");
  await expect(paragraphArticles(freshPage).nth(0)).toHaveAttribute("aria-label", /written by you/);

  await freshContext.close();
});

test("a story-creation failure surfaces as an unsaved indicator, and Retry recovers once the network does", async ({
  page,
}) => {
  await signUp(page, uniqueEmail());

  let shouldFail = true;
  // "**/api/stories" (no trailing wildcard) matches only the create/list
  // endpoint itself, not "/api/stories/[id]/paragraphs" or "/api/stories/[id]".
  await page.route("**/api/stories", (route) => {
    if (route.request().method() === "POST" && shouldFail) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    }
    return route.continue();
  });

  await setMockScript(streamResponse(["A reply, once saving recovers."]));
  await startStory(page, { theme: "a failed save", openingLines: "This should not save at first." });

  // Scoped to the header (`<header>`'s implicit "banner" role) — the same
  // status also renders in the phone nav (`md:hidden`, still in the DOM at
  // this desktop viewport), which would otherwise make this locator
  // ambiguous. Retried with backoff (retry.ts) before finally surfacing — a
  // generous timeout covers that, same reasoning as waitForAiParagraph's.
  const header = page.getByRole("banner");
  await expect(header.getByText("Not saved")).toBeVisible({ timeout: 15_000 });

  shouldFail = false;
  await header.getByRole("button", { name: "Retry" }).click();

  await expect(header.getByText("Saved")).toBeVisible({ timeout: 15_000 });
});

test("a failed report never renders as success", async ({ page }) => {
  await signUp(page, uniqueEmail(), { name: "Writer A" });
  await setMockScript(streamResponse(["A story to (unsuccessfully) report."]));
  await startStory(page, { theme: "a dispute nobody can resolve" });
  await waitForAiParagraph(page, 1);

  await page.getByRole("link", { name: "My library" }).click();
  // ShareToggle updates its own button label optimistically, before the PATCH
  // resolves — waiting on the response itself, not just the label, is what
  // actually proves the share (and its feed-cache invalidation) committed
  // before navigating to /feed below (same reasoning as sharing-feed.spec.ts).
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/stories/") && r.request().method() === "PATCH"),
    page.getByRole("button", { name: "Share to feed" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Shared to feed" })).toBeVisible();

  await page.getByRole("link", { name: "Feed" }).click();
  const feedItem = page.getByRole("link").filter({ hasText: "a dispute nobody can resolve" });
  await expect(feedItem).toBeVisible();
  await feedItem.click();

  await page.route("**/report", (route) => route.fulfill({ status: 500 }));
  await page.getByRole("button", { name: "Report" }).click();

  await expect(page.getByText("Reported — thanks for flagging this.")).toHaveCount(0);
  await expect(page.getByText(/Couldn't send that/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a failed share toggle reverts and says so, from the story canvas", async ({ page }) => {
  await signUp(page, uniqueEmail());
  await setMockScript(streamResponse(["A story that fails to share."]));
  await startStory(page, { theme: "a share that will not stick" });
  await waitForAiParagraph(page, 1);

  await page.route("**/api/stories/*", (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ status: 500 });
    return route.continue();
  });

  // Scoped to the header — the canvas's inline Share control also renders in
  // the phone nav (md:hidden, still in the DOM at this desktop viewport),
  // which would otherwise make these locators ambiguous.
  const header = page.getByRole("banner");
  await header.getByRole("button", { name: "Share to feed" }).click();

  // Reverts to the pre-toggle label, not left showing a share that never
  // actually happened.
  await expect(header.getByRole("button", { name: "Share to feed" })).toBeVisible();
  await expect(header.getByText(/Couldn't update sharing/)).toBeVisible();
});
