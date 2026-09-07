import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import {
  errorResponse,
  getMockCallCount,
  hangResponse,
  resetMockScript,
  setMockScript,
  streamResponse,
  truncateResponse,
} from "../helpers/mock";
import { errorAlert, paragraphArticles, startStory, waitForAiParagraph } from "../helpers/story";

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("provider failure paths", () => {
  test("a provider error before any chunk surfaces as a 502, with a working Try again", async ({
    page,
    request,
  }) => {
    await setMockScript(errorResponse(500, "mock provider exploded"));

    const response = await request.post("/api/generate", {
      data: { providerId: "anthropic", storySoFar: [] },
    });
    expect(response.status()).toBe(502);

    await startStory(page);
    const alert = errorAlert(page);
    await expect(alert).toBeVisible();
    // A fast failure retries once (docs/adr/0023 rule 1) before giving up, and
    // with every provider configured in this harness (playwright.config.ts),
    // the banner always offers a named alternative — "Try again" is what the
    // decline button reads as here, not a single unlabeled retry.
    const tryAgain = alert.getByRole("button", { name: /Try Claude .* again/ });
    await expect(tryAgain).toBeVisible();

    await setMockScript(streamResponse(["It works on retry."]));
    await tryAgain.click();
    await waitForAiParagraph(page, 1);
    await expect(paragraphArticles(page).nth(0)).toContainText("It works on retry.");
  });

  test("a mid-stream drop triggers exactly one silent retry, producing one paragraph not two", async ({
    page,
  }) => {
    await setMockScript(
      truncateResponse(["The signal cut ", "mid-"]),
      streamResponse(["The retry picks up cleanly."])
    );

    // A theme, so this isn't a zero-input kickoff: extractInventedMetadata
    // (src/lib/providers/prompt.ts) only buffers looking for a THEME/---
    // header on a true zero-input turn. Buffering across a stream that never
    // completes cleanly (this test's whole point) has nothing to fall back
    // to and just surfaces as "terminated" before the first chunk — a
    // limitation of the buffering, not of the retry behaviour this test
    // actually cares about.
    await startStory(page, { theme: "a dead radio channel" });
    await waitForAiParagraph(page, 1);

    expect(await getMockCallCount()).toBe(2);
    await expect(paragraphArticles(page)).toHaveCount(1);
    await expect(paragraphArticles(page).nth(0)).toContainText("The retry picks up cleanly.");
  });

  // The FIRST_CHUNK_TIMEOUT_MS budget (src/lib/providers/constants.ts) is a
  // real 20s wait here, not shortened for the test — docs/adr/0023 explicitly
  // keeps the timeouts fixed rather than configurable, so this suite lives
  // with the real duration instead of a seam that only exists for tests.
  const TIMEOUT_BUDGET_MS = 25_000;

  test("a hung provider surfaces an error naming a named alternative within the timeout budget", async ({
    page,
  }) => {
    test.setTimeout(45_000); // FIRST_CHUNK_TIMEOUT_MS (20s) plus page/DB overhead
    await setMockScript(hangResponse());
    await startStory(page);

    // Nothing has settled yet while still within budget.
    await expect(page.getByRole("status")).toHaveText(/is writing a paragraph/);
    await expect(paragraphArticles(page)).toHaveCount(0);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible({ timeout: TIMEOUT_BUDGET_MS });
    // The default provider (registry order) is Claude/Anthropic; the first
    // other configured provider is GPT-5 mini/OpenAI (see e2e/playwright.config.ts).
    await expect(alert.getByRole("button", { name: /Use GPT-5 mini/ })).toBeVisible();
    await expect(alert.getByRole("button", { name: /Try Claude .* again/ })).toBeVisible();
  });

  test("accepting the suggestion switches provider and attributes the next paragraph to it", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await setMockScript(hangResponse(), streamResponse(["Written by the second provider."]));
    await startStory(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible({ timeout: TIMEOUT_BUDGET_MS });
    await alert.getByRole("button", { name: /Use GPT-5 mini/ }).click();

    await waitForAiParagraph(page, 1);
    await expect(paragraphArticles(page).nth(0)).toContainText("Written by the second provider.");
    await expect(paragraphArticles(page).nth(0)).toContainText("GPT-5 mini");
  });

  test("declining the suggestion retries the original provider", async ({ page }) => {
    test.setTimeout(45_000);
    await setMockScript(hangResponse(), streamResponse(["The original provider came through."]));
    await startStory(page);

    const alert = errorAlert(page);
    await expect(alert).toBeVisible({ timeout: TIMEOUT_BUDGET_MS });
    await alert.getByRole("button", { name: /Try Claude .* again/ }).click();

    await waitForAiParagraph(page, 1);
    await expect(paragraphArticles(page).nth(0)).toContainText("The original provider came through.");
    await expect(paragraphArticles(page).nth(0)).toContainText("Claude");
  });
});
