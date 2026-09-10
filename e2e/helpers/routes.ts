import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { signUp, uniqueEmail } from "./auth";
import { errorResponse, resetMockScript, setMockScript, streamResponse } from "./mock";
import { errorAlert, startStory, waitForAiParagraph } from "./story";

export interface RouteCheckpoint {
  /** Stable, filename/title-safe identifier for this state. */
  name: string;
  page: Page;
}

// Comfortably under STREAM_IDLE_TIMEOUT_MS (30s, src/lib/providers/constants.ts)
// so the connection never times out while the rest of this function's setup
// runs, but the "story-mid-generation" checkpoint is placed first in the
// returned array (see below) specifically so callers scan it immediately —
// this budget is slack for that, not something callers should need to lean on.
const MID_STREAM_DELAY_MS = 15_000;

/**
 * Seeds and navigates to every page state Plan 6's gates need to look at —
 * responsive overflow/tap-targets, axe violations — and returns one
 * already-settled Page per state. Shared by responsive.spec.ts and
 * accessibility.spec.ts so the two specs scan the exact same set of states
 * rather than drifting apart from each other over time.
 *
 * Each checkpoint gets its own BrowserContext: cheap here (everything is
 * local — the app under test and the mock provider), and it means one
 * checkpoint's session (signed in, mid-story) can never bleed into another's.
 *
 * "story-mid-generation" is deliberately first in the returned array — it's
 * created last internally, immediately before returning, specifically so a
 * caller that checks checkpoints in order reaches it while the stream is
 * still held open on the first chunk, without racing the rest of this
 * function's setup work.
 */
export async function seedRouteCheckpoints(browser: Browser): Promise<{
  checkpoints: RouteCheckpoint[];
  cleanup: () => Promise<void>;
}> {
  const contexts: BrowserContext[] = [];
  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  const rest: RouteCheckpoint[] = [];

  const home = await newPage();
  await home.goto("/");
  rest.push({ name: "home", page: home });

  const login = await newPage();
  await login.goto("/login");
  rest.push({ name: "login", page: login });

  const signup = await newPage();
  await signup.goto("/signup");
  rest.push({ name: "signup", page: signup });

  const notFound = await newPage();
  await notFound.goto("/not-a-real-page");
  rest.push({ name: "not-found", page: notFound });

  // A fresh guest visit, nothing generated yet — StoryContext's default state.
  const storyEmpty = await newPage();
  await storyEmpty.goto("/story");
  rest.push({ name: "story-empty", page: storyEmpty });

  await resetMockScript();

  await setMockScript(streamResponse(["The tide finally turned in their favor."]));
  const storyWithParagraphs = await newPage();
  await startStory(storyWithParagraphs, { theme: "a tide pool rescue" });
  await waitForAiParagraph(storyWithParagraphs, 1);
  rest.push({ name: "story-with-paragraphs", page: storyWithParagraphs });

  await setMockScript(errorResponse(500, "mock provider exploded"));
  const storyError = await newPage();
  await startStory(storyError, { theme: "a signal that never arrives" });
  await expect(errorAlert(storyError)).toBeVisible();
  rest.push({ name: "story-error", page: storyError });

  // Writer A owns a library entry and shares it; Writer B sees it in the feed.
  await setMockScript(streamResponse(["A shared beginning, ready to scan."]));
  const library = await newPage();
  await signUp(library, uniqueEmail(), { name: "Writer A" });
  await startStory(library, { theme: "a shared story for scanning" });
  await waitForAiParagraph(library, 1);
  await library.getByRole("link", { name: "My library" }).click();
  await library.getByRole("button", { name: "Share to feed" }).click();
  await expect(library.getByRole("button", { name: "Shared to feed" })).toBeVisible();
  // Playwright's .click() leaves the cursor parked on the clicked element —
  // without this, axe would scan (and correctly flag) the button's
  // lower-contrast :hover state as if it were resting, which it isn't.
  await library.mouse.move(0, 0);
  rest.push({ name: "library", page: library });

  const feed = await newPage();
  await signUp(feed, uniqueEmail(), { name: "Writer B" });
  await feed.getByRole("link", { name: "Feed" }).click();
  const feedItem = feed.getByRole("link").filter({ hasText: "a shared story for scanning" });
  await expect(feedItem).toBeVisible();
  rest.push({ name: "feed", page: feed });

  const feedDetail = await newPage();
  await signUp(feedDetail, uniqueEmail(), { name: "Writer C" });
  await feedDetail.goto("/feed");
  await feedDetail.getByRole("link").filter({ hasText: "a shared story for scanning" }).click();
  await expect(feedDetail).toHaveURL(/\/feed\//);
  rest.push({ name: "feed-detail", page: feedDetail });

  await resetMockScript();

  // Created last, returned first — see the function comment above.
  await setMockScript(
    streamResponse(["The lantern flickered twice before catching. "], { delayMs: MID_STREAM_DELAY_MS })
  );
  const storyStreaming = await newPage();
  await startStory(storyStreaming, { theme: "a lantern-lit harbor" });
  await expect(storyStreaming.getByRole("status")).toHaveText(/is writing a paragraph/);
  await expect(storyStreaming.locator("article", { hasText: "The lantern flickered" })).toBeVisible();

  const checkpoints: RouteCheckpoint[] = [{ name: "story-mid-generation", page: storyStreaming }, ...rest];

  return {
    checkpoints,
    cleanup: async () => {
      await resetMockScript();
      await Promise.all(contexts.map((c) => c.close()));
    },
  };
}
