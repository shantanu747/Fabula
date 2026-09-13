import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { paragraphArticles, startStory, waitForAiParagraph } from "../helpers/story";

// docs/adr/0043 — a client that disconnects mid-generation and reconnects
// within the grace window recovers the paragraph, rather than losing it.
// Needs a real Redis (see e2e/global-setup.ts's up-front check) — with none
// configured, resume is inert and this scenario degrades to the ordinary
// disconnect-loses-the-paragraph behavior these specs otherwise don't cover.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("resumable generation", () => {
  test("a network drop mid-generation recovers the paragraph once connectivity returns", async ({
    page,
    context,
  }) => {
    test.setTimeout(45_000);
    // Slow enough (chunk delay) that there's a real window to go offline and
    // back before the mock provider finishes, comfortably inside
    // RESUME_GRACE_MS (15s, src/lib/providers/constants.ts) so the server-side
    // generation is still expected to complete rather than itself time out.
    await setMockScript(
      streamResponse(["The tunnel swallows the signal, ", "but the story keeps going, ", "and comes out the other side."], {
        delayMs: 800,
      })
    );

    await startStory(page, { theme: "a train through the mountains" });

    // Let at least the first chunk arrive before cutting the connection —
    // otherwise this could race the pre-fetch-first-chunk phase, where a
    // disconnect has nothing to resume (docs/adr/0043) and behaves exactly
    // like today's immediate abort instead.
    await expect(page.getByRole("status")).toHaveText(/is writing a paragraph/);
    await page.waitForTimeout(900);

    await context.setOffline(true);
    await page.waitForTimeout(2_500);
    await context.setOffline(false);

    await waitForAiParagraph(page, 1);
    await expect(paragraphArticles(page).nth(0)).toContainText(
      "The tunnel swallows the signal, but the story keeps going, and comes out the other side."
    );
  });
});
