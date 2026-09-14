import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { getLastEmailLink, signIn, signUp, uniqueEmail } from "../helpers/auth";
import { errorAlert, paragraphArticles, startStory, waitForAiParagraph } from "../helpers/story";

// docs/plans/v4/06-account-lifecycle.md's "Verification" section.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("signup, then share is blocked until the real verification link is followed", async ({ page, request }) => {
  const email = uniqueEmail();
  await signUp(page, email, { name: "New Writer" });

  await setMockScript(streamResponse(["A beginning, before verifying."]));
  await startStory(page, { theme: "an unverified beginning" });
  await waitForAiParagraph(page, 1);

  await page.getByRole("link", { name: "My library" }).click();

  // Share before verifying fails cleanly, with a clear message — not a
  // silent no-op and not a raw error (docs/adr/0046's gating decision).
  await expect(page.getByRole("button", { name: "Share to feed", exact: true })).toBeDisabled();
  await expect(page.getByText("Verify your email to share.")).toBeVisible();

  // Follow the real link from the console-logged email — no shortcut through
  // the database, proving the actual end-to-end flow works.
  const link = await getLastEmailLink(request, email);
  // The success page's own effect calls useSession().update() to refresh the
  // JWT's `verified` claim (src/app/verify/page.tsx, docs/adr/0047) — waiting
  // for that round trip (same technique as signUpAndVerify) avoids racing it
  // with the navigation below.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session")),
    page.goto(link),
  ]);
  await expect(page).toHaveURL(/\/verify\?status=success/);
  await expect(page.getByText("Your email is verified.")).toBeVisible();

  await page.getByRole("link", { name: "Go to my library" }).click();
  await expect(page).toHaveURL("/library");

  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/stories/") && r.request().method() === "PATCH"),
    page.getByRole("button", { name: "Share to feed" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Shared to feed" })).toBeVisible();
});

test("an invalid or already-used verification link reports itself as such", async ({ page }) => {
  await page.goto("/api/auth/verify/not-a-real-token");
  await expect(page).toHaveURL(/\/verify\?status=invalid/);
  await expect(page.getByText("This verification link is invalid or has expired.")).toBeVisible();
});

test("forgot password: resetting invalidates a session open in another browser", async ({ page, browser, request }) => {
  const email = uniqueEmail();
  const password = "the original password 1";
  await signUp(page, email, { password });

  // A second, still-signed-in browser context — the session this reset must
  // invalidate.
  const otherContext = await browser.newContext({ storageState: await page.context().storageState() });
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/library");
  await expect(otherPage).toHaveURL("/library"); // still authenticated

  await page.goto("/forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/we've sent a reset link/i)).toBeVisible();

  const link = await getLastEmailLink(request, email);
  const newPassword = "a brand new password 2";
  await page.goto(link);
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/password has been reset/i)).toBeVisible();

  // The other browser's session is now stale — its next attempt to generate
  // (an authenticated call, since it's still carrying the pre-reset cookie)
  // must be rejected outright rather than silently spending that account's
  // budget under a tokenVersion that no longer matches (docs/adr/0047).
  await setMockScript(streamResponse(["Should never be generated."]));
  await startStory(otherPage, { theme: "a session that should be dead" });
  // Filtered, not the bare helper: the header's "Not saved" indicator is also
  // role="alert" (rendered twice — desktop header and phone nav), which
  // would otherwise make this a strict-mode violation.
  await expect(errorAlert(otherPage).filter({ hasText: "session is no longer valid" })).toBeVisible();
  await expect(paragraphArticles(otherPage)).toHaveCount(0);
  await otherContext.close();

  // Sign in with the *new* password proves the reset actually took effect.
  await page.goto("/login");
  await signIn(page, email, newPassword);
  await expect(page).toHaveURL("/");
});

test("login lockout: repeated wrong passwords are rate limited, distinctly from a wrong password", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email, { password: "the correct password 1" });
  await page.getByRole("button", { name: "Sign out" }).click();
  // Waits for the signed-out header to actually render, not just a URL match
  // — signOut()'s own redirect can still be settling (a possible further
  // redirect through proxy.ts) when a URL alone would already match, and
  // racing page.goto("/login") against that in-flight navigation is what
  // produces a flaky net::ERR_ABORTED otherwise.
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.goto("/login");
  // LOGIN_ACCOUNT's capacity is 5 (src/lib/ratelimit/policy.ts) — but signUp()
  // above already spent one of those five itself (the client automatically
  // calls signIn() right after a successful registration), so only four
  // wrong attempts remain before the bucket is exhausted here.
  for (let i = 0; i < 4; i++) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  }

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("the correct password 1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Too many attempts. Try again in a few minutes.")).toBeVisible();
});
