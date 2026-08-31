import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { errorAlert, startStory, waitForAiParagraph } from "../helpers/story";

// ADR 0004 — strict turn-taking policy.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("turn-taking policy", () => {
  test("the continue button stays disabled until the Writer has typed something", async ({ page }) => {
    await setMockScript(streamResponse(["The gate creaked on its hinge."]));
    await startStory(page);
    await waitForAiParagraph(page, 1);

    const continueButton = page.getByRole("button", { name: "Continue the Story" });
    await expect(continueButton).toBeDisabled();

    await page.getByLabel("Write the next paragraph").fill("   ");
    await expect(continueButton).toBeDisabled(); // whitespace-only draft

    await page.getByLabel("Write the next paragraph").fill("She pushed it open anyway.");
    await expect(continueButton).toBeEnabled();
  });

  test("the server rejects an out-of-turn generation request with 409", async ({ request }) => {
    const response = await request.post("/api/generate", {
      data: {
        providerId: "anthropic",
        storySoFar: [{ author: "ai", text: "The gate creaked on its hinge." }],
      },
    });
    expect(response.status()).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("It's the Writer's turn — the AI can't generate two paragraphs in a row.");
  });

  test("a turn-violation response renders an error with no Try again button", async ({ page }) => {
    await setMockScript(streamResponse(["The gate creaked on its hinge."]));
    await startStory(page);
    await waitForAiParagraph(page, 1);

    // Forces the same 409 the server returns for a genuine out-of-turn request
    // (see the API-level test above), so this test can assert purely on the
    // client's rendering of it without racing the UI's own turn gating (the
    // Continue button is legitimately disabled the rest of the time).
    await page.route("**/api/generate", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "It's the Writer's turn — the AI can't generate two paragraphs in a row.",
        }),
      })
    );

    await page.getByLabel("Write the next paragraph").fill("She pushed it open anyway.");
    await page.getByRole("button", { name: "Continue the Story" }).click();

    const alert = errorAlert(page);
    await expect(alert).toContainText("It's the Writer's turn");
    await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });
});
