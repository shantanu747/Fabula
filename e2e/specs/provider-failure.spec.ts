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
    const tryAgain = alert.getByRole("button", { name: "Try again" });
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

  // TODO(plan-04): there is no server-side generation timeout yet, so a hung
  // provider just hangs forever — this asserts today's (undesirable) behaviour
  // rather than a timeout, so Plan 4 has a failing test to make pass once it
  // adds one. waitForTimeout is normally off-limits in this suite (see
  // ../../docs/plans/v3/02-e2e-journeys.md's "Assertions to avoid"), but there
  // is no settled state to poll toward here — nothing ever changes, which is
  // exactly the thing being asserted.
  test("a hung provider has no timeout yet", async ({ page }) => {
    await setMockScript(hangResponse());
    await startStory(page);

    await page.waitForTimeout(5_000);
    await expect(page.getByRole("status")).toHaveText(/is writing a paragraph/);
    await expect(errorAlert(page)).toHaveCount(0);
    await expect(paragraphArticles(page)).toHaveCount(0);
  });
});
