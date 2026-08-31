import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { signUp, uniqueEmail } from "../helpers/auth";
import { startStory, waitForAiParagraph } from "../helpers/story";

// PRD §8 criterion 5.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("reporting a shared story succeeds once and is a no-op on a repeat report", async ({ page, browser }) => {
  await signUp(page, uniqueEmail(), { name: "Writer A" });
  await setMockScript(streamResponse(["A story worth reporting, allegedly."]));
  await startStory(page, { theme: "a dispute over a fence line" });
  await waitForAiParagraph(page, 1);

  await page.getByRole("link", { name: "My library" }).click();
  await page.getByRole("button", { name: "Share to feed" }).click();
  await expect(page.getByRole("button", { name: "Shared to feed" })).toBeVisible();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await signUp(pageB, uniqueEmail(), { name: "Writer B" });

  await pageB.getByRole("link", { name: "Feed" }).click();
  await pageB.getByRole("link").filter({ hasText: "a dispute over a fence line" }).click();
  await expect(pageB).toHaveURL(/\/feed\//);

  await pageB.getByRole("button", { name: "Report" }).click();
  await expect(pageB.getByText("Reported — thanks for flagging this.")).toBeVisible();

  // A second report from the same Writer is a no-op, not a duplicate or an
  // error — the unique constraint on (storyId, reporterId) is what makes this
  // idempotent (see src/app/api/stories/[id]/report/route.ts). Driven at the
  // API level, reusing pageB's session cookie, since the UI's ReportButton
  // unmounts its own button on success and offers no way to click it twice.
  const storyId = pageB.url().split("/feed/")[1];
  const secondReport = await pageB.request.post(`/api/stories/${storyId}/report`);
  expect(secondReport.status()).toBe(200);
  const body = await secondReport.json();
  expect(body.ok).toBe(true);

  await contextB.close();
});
