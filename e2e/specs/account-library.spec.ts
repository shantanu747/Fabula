import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { startStory, waitForAiParagraph, writeParagraph } from "../helpers/story";

// PRD §8 criteria 1 (auth works end-to-end) and 2 (a signed-in story survives
// a closed tab and reappears in the library).

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a signed-in Writer's story is listed in the library and survives a fresh session", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await expect(page).toHaveURL("/");

  await setMockScript(streamResponse(["Paragraph the first."]));
  await startStory(page, { theme: "a quiet heist" });
  await waitForAiParagraph(page, 1);

  await setMockScript(streamResponse(["Paragraph the third."]));
  await writeParagraph(page, "Paragraph the second.");
  await waitForAiParagraph(page, 3);

  await page.getByRole("link", { name: "My library" }).click();
  await expect(page).toHaveURL("/library");

  const storyItem = page.getByRole("link").filter({ hasText: "a quiet heist" });
  await expect(storyItem).toContainText("3 paragraphs");
  await expect(storyItem).toContainText("a quiet heist");

  // A fresh browser context with the same storage state, rather than reloading
  // this tab — proves the story is server-persisted, not just this tab's
  // in-memory StoryContext.
  const storageState = await page.context().storageState();
  const freshContext = await browser.newContext({ storageState });
  const freshPage = await freshContext.newPage();
  await freshPage.goto("/library");
  await expect(freshPage.getByRole("link").filter({ hasText: "a quiet heist" })).toContainText("3 paragraphs");
  await freshContext.close();
});
