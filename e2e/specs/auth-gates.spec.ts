import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { registerAccount, signIn, uniqueEmail } from "../helpers/auth";

// src/proxy.ts.

test.beforeEach(async () => {
  await resetDatabase();
});

test.describe("auth gates", () => {
  test("redirects /library to /login with callbackUrl, and returns there after sign-in", async ({
    page,
    request,
  }) => {
    await page.goto("/library");
    await expect(page).toHaveURL("/login?callbackUrl=%2Flibrary");

    const email = uniqueEmail();
    await registerAccount(request, email);
    await signIn(page, email);
    await expect(page).toHaveURL("/library");
  });

  test("redirects /feed to /login with callbackUrl too", async ({ page }) => {
    await page.goto("/feed");
    await expect(page).toHaveURL("/login?callbackUrl=%2Ffeed");
  });

  test("guest writing is never gated: / and /story remain reachable while signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/");
    await page.goto("/story");
    await expect(page).toHaveURL("/story");
  });
});
