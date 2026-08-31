import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { paragraphArticles, waitForAiParagraph, writeParagraph } from "../helpers/story";

// PRD §8 criterion 2, resume half.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a saved story resumes with every paragraph, its metadata, and appends at the right position", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail();
  await signUp(page, email);

  await setMockScript(streamResponse(["The first reply."]));
  await page.goto("/");
  await page.getByLabel("Genre or theme").fill("a locked-room mystery");
  await page.getByLabel("Starter characters").fill("Odile, a night-shift clerk");
  await page.getByRole("button", { name: /Let's write/ }).click();
  await page.waitForURL("**/story");
  await waitForAiParagraph(page, 1); // no opening lines given, so the AI goes first

  const originalTargetLength = await page.locator("#target-length").inputValue();

  await setMockScript(streamResponse(["The second reply."]));
  await writeParagraph(page, "Odile counted the till twice.");
  await waitForAiParagraph(page, 3);

  // A fresh context, not this tab reloaded: /story's hydration effect
  // (src/app/story/page.tsx) only fires when the requested storyId differs
  // from the one already in client state, which is never true for this same
  // tab once it has created the story. A fresh page has no client state at all.
  const storageState = await page.context().storageState();
  const freshContext = await browser.newContext({ storageState });
  const freshPage = await freshContext.newPage();

  await freshPage.goto("/library");
  await freshPage.getByRole("link", { name: /locked-room mystery/ }).click();
  await freshPage.waitForURL(/\/story\?storyId=/);
  await waitForAiParagraph(freshPage, 3);

  await expect(paragraphArticles(freshPage).nth(0)).toContainText("The first reply.");
  await expect(paragraphArticles(freshPage).nth(0)).toHaveAttribute("aria-label", /written by Claude/);
  await expect(paragraphArticles(freshPage).nth(1)).toContainText("Odile counted the till twice.");
  await expect(paragraphArticles(freshPage).nth(1)).toHaveAttribute("aria-label", /written by you/);
  await expect(paragraphArticles(freshPage).nth(2)).toContainText("The second reply.");
  await expect(paragraphArticles(freshPage).nth(2)).toHaveAttribute("aria-label", /written by Claude/);

  await expect(freshPage.getByText("a locked-room mystery")).toBeVisible();
  await expect(freshPage.getByText("Odile, a night-shift clerk")).toBeVisible();
  await expect(freshPage.locator("#target-length")).toHaveValue(originalTargetLength);

  // Continue writing: the new paragraph must land at the end, not duplicate
  // anything, and not overwrite position 0.
  await setMockScript(streamResponse(["The third reply, appended correctly."]));
  await writeParagraph(freshPage, "Odile called it in.");
  await waitForAiParagraph(freshPage, 5);

  await expect(paragraphArticles(freshPage).nth(0)).toContainText("The first reply.");
  await expect(paragraphArticles(freshPage).nth(3)).toContainText("Odile called it in.");
  await expect(paragraphArticles(freshPage).nth(4)).toContainText("The third reply, appended correctly.");

  await freshContext.close();
});
