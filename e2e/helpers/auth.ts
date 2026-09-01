import type { APIRequestContext, Page } from "@playwright/test";

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
    data: { name: opts?.name ?? "Test Writer", email, password: opts?.password ?? DEFAULT_PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(`registerAccount: register API returned ${response.status()}`);
  }
}
