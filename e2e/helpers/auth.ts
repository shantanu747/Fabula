import type { APIRequestContext, Page } from "@playwright/test";
import { verifyEmail } from "./db";
import { BASE_URL } from "../constants";

const DEFAULT_PASSWORD = "correct horse battery staple";

let counter = 0;
/** The user.email unique constraint plus onConflictDoNothing in the register
 *  route means a reused address silently produces a no-op signup and a
 *  confusing auth failure downstream — every spec that creates an account must
 *  use this. */
export function uniqueEmail(): string {
  counter += 1;
  return `e2e-${Date.now()}-${counter}@example.test`;
}

/** Fills and submits the signup form. The app signs the new account in
 *  immediately afterwards (see src/app/signup/page.tsx), so `page` ends this
 *  call authenticated as the new user. */
export async function signUp(
  page: Page,
  email: string,
  opts?: { name?: string; password?: string }
): Promise<void> {
  const password = opts?.password ?? DEFAULT_PASSWORD;
  await page.goto("/signup");
  await page.getByLabel("Name").fill(opts?.name ?? "Test Writer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}

/** Fills and submits the login form on whatever page /login was reached from
 *  (a bare visit, or a proxy.ts redirect with a callbackUrl already in the
 *  URL) — does not navigate to /login itself, so a caller checking the
 *  callbackUrl redirect (auth-gates.spec.ts) can assert on the URL it arrived
 *  at before calling this. */
export async function signIn(page: Page, email: string, password = DEFAULT_PASSWORD): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}

/**
 * `signUp` plus a verified email — for every spec whose real subject is
 * something *downstream* of verification (sharing, reporting, the feed)
 * rather than the verification flow itself (that's account-lifecycle.spec.ts's
 * job). Marks the row verified directly (helpers/db.ts's `verifyEmail`,
 * bypassing the actual click-through-the-link flow) and then forces this
 * browser's own session to pick it up: `emailVerified` is only ever
 * refreshed into the JWT at sign-in or on an explicit `update()` call
 * (src/auth.ts's jwt callback, docs/adr/0047) — visiting `/verify?status=success`
 * is what triggers that same call in the real flow, and it works here too
 * even though no real token was involved.
 */
export async function signUpAndVerify(page: Page, email: string, opts?: { name?: string; password?: string }): Promise<void> {
  await signUp(page, email, opts);
  await verifyEmail(email);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session")),
    page.goto("/verify?status=success"),
  ]);
}

/**
 * Recovers the link from the most recent email ConsoleMailer "sent" to an
 * address — GET /api/auth/verify/[token] or /reset?token=..., depending on
 * which flow the spec is exercising. Backed by the E2E_TEST_MODE-gated
 * `/api/__test/last-email` route (docs/adr/0046); the token itself is never
 * recoverable from the database, since only its hash is stored there.
 */
export async function getLastEmailLink(request: APIRequestContext, to: string): Promise<string> {
  const response = await request.get(`/api/__test/last-email?to=${encodeURIComponent(to)}`);
  if (!response.ok()) {
    throw new Error(`getLastEmailLink: no email found for ${to} (${response.status()})`);
  }
  const { text } = (await response.json()) as { text: string };
  const match = text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`getLastEmailLink: no link found in email body for ${to}`);
  return match[0];
}

/**
 * Registers an account via the API directly, without touching `page`'s
 * cookies/session — for guest-adoption.spec.ts, which needs an account to
 * exist while the page under test stays an unauthenticated guest until it
 * explicitly signs in later in the same test.
 */
export async function registerAccount(
  request: APIRequestContext,
  email: string,
  opts?: { name?: string; password?: string }
): Promise<void> {
  const response = await request.post("/api/auth/register", {
    // Origin set explicitly — APIRequestContext doesn't add one the way a
    // real browser fetch() does, and assertSameOrigin (docs/adr/0048)
    // requires it.
    headers: { Origin: BASE_URL },
    data: { name: opts?.name ?? "Test Writer", email, password: opts?.password ?? DEFAULT_PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(`registerAccount: register API returned ${response.status()}`);
  }
}
