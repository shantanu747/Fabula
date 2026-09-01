import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { registerAccount, signIn, uniqueEmail } from "../helpers/auth";
import { paragraphArticles, startStory, waitForAiParagraph } from "../helpers/story";

// PRD §8 criterion 3. The subtlest one: a guest's pre-login paragraphs must
// persist once they sign in mid-story, with no separate "import" step.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a guest's paragraphs persist once signed in mid-story, without a separate import step", async ({
  page,
  request,
}) => {
  const email = uniqueEmail();
  // Registered directly via the API, not through the UI — signUp() would sign
  // `page` in immediately, and this test needs `page` to stay an unauthenticated
  // guest until it explicitly signs in later.
  await registerAccount(request, email);

  await setMockScript(streamResponse(["A stranger answered from the dark."]));
  await startStory(page, { openingLines: "Two Writers began this, though only one knew it." });
  await waitForAiParagraph(page, 2);

  // Sign in from the header without leaving the story. This works only because
  // the whole app is wrapped in StoryProvider at the root layout (src/app/layout.tsx),
  // so client-side navigation (the header's <Link>, and the login form's
  // router.push after signIn()) never remounts it — a page.goto() here would
  // instead force a full reload and lose the guest's paragraphs.
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, email);
  // No callbackUrl is attached to the header's Sign in link, so safeCallbackUrl
  // defaults to "/" — the guest's paragraphs are still in memory regardless.
  await expect(page).toHaveURL("/");

  // Continue writing: the home page's Opening lines field still holds what was
  // typed before sign-in, so it's overwritten with the next paragraph rather
  // than resubmitting the old text. This first post-login turn is what fires
  // ensureStoryId() and, via /api/generate's diff-based sync, adopts the whole
  // pre-login backlog in one shot (docs/adr/0009) — not a dedicated import step.
  await setMockScript(streamResponse(["The dark answered a second time."]));
  await page.getByLabel("Opening lines").fill("A third voice, now signed in, joined them.");
  await page.getByRole("button", { name: /Let's write/ }).click();
  await page.waitForURL("**/story");
  await waitForAiParagraph(page, 4);

  await expect(paragraphArticles(page).nth(0)).toContainText("Two Writers began this");
  await expect(paragraphArticles(page).nth(0)).toHaveAttribute("aria-label", /written by you/);
  await expect(paragraphArticles(page).nth(1)).toContainText("A stranger answered from the dark.");
  await expect(paragraphArticles(page).nth(1)).toHaveAttribute("aria-label", /written by Claude/);
  await expect(paragraphArticles(page).nth(2)).toContainText("A third voice, now signed in, joined them.");
  await expect(paragraphArticles(page).nth(2)).toHaveAttribute("aria-label", /written by you/);
  await expect(paragraphArticles(page).nth(3)).toContainText("The dark answered a second time.");
  await expect(paragraphArticles(page).nth(3)).toHaveAttribute("aria-label", /written by Claude/);

  // /library now contains the story with all four paragraphs, including the
  // two written before sign-in. No theme/characters were set (only opening
  // lines), so the library lists it as "Untitled story" — there's exactly one
  // story for this fresh account, so the single list item is unambiguous.
  await page.getByRole("link", { name: "My library" }).click();
  await expect(page.getByRole("listitem")).toContainText("4 paragraphs");
});
