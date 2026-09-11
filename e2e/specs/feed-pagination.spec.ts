import { test, expect } from "@playwright/test";
import { resetDatabase, seedSharedStories } from "../helpers/db";
import { resetMockScript } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";

// Plan v4/03: the feed pages with a keyset cursor (PAGE_SIZE = 20 in
// src/lib/db/feedAndLibrary.ts), not OFFSET, and page 0 renders server-side.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("pages the feed across a keyset boundary via Load more, with no duplicates or gaps", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email, { name: "Prolific Writer" });
  await seedSharedStories(email, 23); // one full page (20) plus a partial second page (3)

  await page.goto("/feed");

  const items = page.getByRole("link").filter({ hasText: "seeded story" });
  await expect(items).toHaveCount(20);

  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  await expect(items).toHaveCount(23);
  // No page boundary duplicated or skipped a row: 23 distinct titles, not 23
  // renders of fewer than 23 actual stories.
  const titles = await items.allTextContents();
  const distinctTitles = new Set(titles.map((t) => t.match(/seeded story \d+/)?.[0]));
  expect(distinctTitles.size).toBe(23);

  // The button disappears once nothing more remains — proves nextCursor
  // actually went null rather than the client just running out of patience.
  await expect(loadMore).toHaveCount(0);
});

test("renders the feed's first page without client JS", async ({ page, context }) => {
  const email = uniqueEmail();
  await signUp(page, email, { name: "SSR Writer" });
  await seedSharedStories(email, 3);

  // A fresh, JS-disabled context still carries the signed-in cookie via
  // storageState — proves page 0 is real server-rendered HTML, not a client
  // fetch that happens to resolve fast: with JS off, no fetch could run at all.
  const storageState = await context.storageState();
  const noJsContext = await page.context().browser()!.newContext({ storageState, javaScriptEnabled: false });
  const noJsPage = await noJsContext.newPage();

  await noJsPage.goto("/feed");
  // Text presence in the DOM, not CSS visibility — with JavaScript disabled,
  // some styling can behave oddly for reasons unrelated to the property under
  // test (whether the content was server-rendered at all). The content being
  // in the markup a JS-less browser received is exactly that proof.
  await expect(noJsPage.locator("body")).toContainText("seeded story");

  await noJsContext.close();
});
