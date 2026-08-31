import { expect, type Page } from "@playwright/test";

/** The growing story region (`role="log"`) — scope paragraph queries to this
 *  rather than the whole page, since /feed/[id] renders paragraphs too. */
export function storyLog(page: Page) {
  return page.getByRole("log", { name: "Story so far" });
}

/** Settled paragraphs only — the in-progress streaming preview is
 *  `aria-hidden`, so it's already excluded from this. */
export function paragraphArticles(page: Page) {
  return storyLog(page).getByRole("article");
}

/**
 * Fills the home page's optional fields and starts the story — Writer-first if
 * `openingLines` is given (submitAndContinue), AI-first otherwise
 * (generateNext). Lands on /story; does not wait for the AI paragraph to
 * settle — call waitForAiParagraph for that.
 */
export async function startStory(
  page: Page,
  opts?: { openingLines?: string; theme?: string; characters?: string }
): Promise<void> {
  await page.goto("/");
  if (opts?.theme) await page.getByLabel("Genre or theme").fill(opts.theme);
  if (opts?.characters) await page.getByLabel("Starter characters").fill(opts.characters);
  if (opts?.openingLines) await page.getByLabel("Opening lines").fill(opts.openingLines);
  await page.getByRole("button", { name: /Let's write/ }).click();
  await page.waitForURL("**/story");
}

/** Fills the Writer's compose box on /story and submits — Writer paragraph
 *  first, then the AI's reply starts generating. Does not wait for the AI
 *  paragraph to settle — call waitForAiParagraph for that. */
export async function writeParagraph(page: Page, text: string): Promise<void> {
  await page.getByLabel("Write the next paragraph").fill(text);
  await page.getByRole("button", { name: "Continue the Story" }).click();
}

/** Waits for exactly `n` settled paragraphs in the log — not waitForTimeout,
 *  and not networkidle (which streaming responses defeat). */
export async function waitForAiParagraph(page: Page, n: number): Promise<void> {
  await expect(paragraphArticles(page)).toHaveCount(n, { timeout: 15_000 });
}

/**
 * The app's own generation-error banner (`role="alert"` in
 * src/app/story/page.tsx). Next.js also renders a `role="alert"` route
 * announcer (`#__next-route-announcer__`, for screen-reader navigation
 * announcements) on every page, which a bare `page.getByRole("alert")` also
 * matches — as a second, usually-empty element that turns an assertion
 * expecting exactly one into a strict-mode violation, or a "no alert"
 * assertion into a false positive. Excluded by id, not by Tailwind class.
 */
export function errorAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
