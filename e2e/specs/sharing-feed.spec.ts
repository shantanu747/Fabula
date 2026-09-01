import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { startStory, waitForAiParagraph } from "../helpers/story";

// PRD §8 criterion 4.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("toggling sharing makes a story visible in another account's feed, and unsharing removes it", async ({
  page,
  browser,
}) => {
  await signUp(page, uniqueEmail(), { name: "Writer A" });

  await setMockScript(streamResponse(["A shared beginning."]));
  await startStory(page, { theme: "a rooftop garden" });
  await waitForAiParagraph(page, 1);

  await page.getByRole("link", { name: "My library" }).click();
  await page.getByRole("button", { name: "Share to feed" }).click();
  await expect(page.getByRole("button", { name: "Shared to feed" })).toBeVisible();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await signUp(pageB, uniqueEmail(), { name: "Writer B" });

  await pageB.getByRole("link", { name: "Feed" }).click();
  await expect(pageB.getByText(/Shared stories include unmoderated human-written text/)).toBeVisible();

  const feedItem = pageB.getByRole("link").filter({ hasText: "a rooftop garden" });
  await expect(feedItem).toContainText("Writer A");
  await expect(feedItem).toContainText("1 paragraph");

  await feedItem.click();
  await expect(pageB).toHaveURL(/\/feed\//);
  await expect(pageB.getByText("Shared by Writer A")).toBeVisible();
  // Read-only: no compose textarea, no continue control.
  await expect(pageB.getByLabel("Write the next paragraph")).toHaveCount(0);
  await expect(pageB.getByRole("button", { name: "Continue the Story" })).toHaveCount(0);

  // A unshares.
  await page.getByRole("button", { name: "Shared to feed" }).click();
  await expect(page.getByRole("button", { name: "Share to feed" })).toBeVisible();

  await pageB.goto("/feed");
  await expect(pageB.getByRole("link").filter({ hasText: "a rooftop garden" })).toHaveCount(0);

  await contextB.close();
});
