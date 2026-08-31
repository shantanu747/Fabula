import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { paragraphArticles, startStory, waitForAiParagraph, writeParagraph } from "../helpers/story";

// PRD §5 happy path, no account.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test.describe("guest write journey", () => {
  test("the AI writes the opening paragraph, invents a theme, and is attributed by name", async ({ page }) => {
    await setMockScript(
      streamResponse(["The lighthouse had not blinked in ", "eleven years, and Mara noticed."], {
        delayMs: 80,
        invented: { theme: "a stubborn coastal mystery", characters: "Mara, a keeper's daughter" },
      })
    );

    await startStory(page);

    // Streams: text present and growing, then settled. The in-progress preview
    // is deliberately aria-hidden (see src/app/story/page.tsx) so an attribute
    // selector is the only way to observe it — there is no accessible
    // alternative for text that the app itself hides from the a11y tree.
    const preview = page.locator('article[aria-hidden="true"]');
    await expect(preview).toContainText("The lighthouse had not blinked");
    await expect(preview).toContainText("Claude (Anthropic)");
    await expect(paragraphArticles(page)).toHaveCount(0); // second chunk hasn't landed yet

    await waitForAiParagraph(page, 1);
    const first = paragraphArticles(page).nth(0);
    await expect(first).toContainText("eleven years, and Mara noticed.");
    await expect(first).toHaveAttribute("aria-label", /written by Claude \(Anthropic\)/);

    // The invented theme/characters chip, rendered from the out-of-band
    // metadata sentinel (docs/adr/0003).
    await expect(page.getByText("a stubborn coastal mystery")).toBeVisible();
    await expect(page.getByText("Mara, a keeper's daughter")).toBeVisible();
  });

  test("a Writer paragraph and the AI reply land in order", async ({ page }) => {
    await setMockScript(streamResponse(["The tide answered before she did."]));
    await startStory(page);
    await waitForAiParagraph(page, 1);

    await setMockScript(streamResponse(["Nobody had asked it to."]));
    await writeParagraph(page, '"Not tonight," Mara said.');
    await waitForAiParagraph(page, 3);

    await expect(paragraphArticles(page).nth(1)).toContainText("Not tonight");
    await expect(paragraphArticles(page).nth(1)).toHaveAttribute("aria-label", /written by you/);
    await expect(paragraphArticles(page).nth(2)).toContainText("Nobody had asked it to");
    await expect(paragraphArticles(page).nth(2)).toHaveAttribute("aria-label", /written by Claude/);
  });

  test("New story clears the canvas and resets state", async ({ page }) => {
    await setMockScript(streamResponse(["A single paragraph to start."]));
    await startStory(page);
    await waitForAiParagraph(page, 1);

    await page.getByRole("link", { name: "New story" }).click();
    await expect(page).toHaveURL("/");

    // A hard reload would trivially look empty regardless of whether resetStory()
    // actually fired, so this proves the reset by generating fresh and checking
    // the count starts back at 1 rather than accumulating on the old paragraph.
    await setMockScript(streamResponse(["A brand new story begins."]));
    await page.getByRole("button", { name: /Let's write/ }).click();
    await page.waitForURL("**/story");
    await waitForAiParagraph(page, 1);
    await expect(paragraphArticles(page).nth(0)).toContainText("A brand new story begins.");
  });
});
