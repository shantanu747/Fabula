// Imported from @auth/core directly, not next-auth's own barrel (which
// re-exports the identical class) — next-auth/index.js unconditionally pulls
// in next/server at module scope, which breaks importing this file from a
// plain Vitest/Node test environment that isn't running inside Next itself.
import { CredentialsSignin } from "@auth/core/errors";

/**
 * Auth.js maps a thrown CredentialsSignin's `code` to the client-visible
 * `result.code` from `signIn()` (never `result.error`, which stays the
 * generic "CredentialsSignin" for every credentials failure) — this is the
 * one thing the login page can safely branch on to show a different message
 * for "you're rate limited" versus "wrong password" (docs/adr/0046).
 */
export class TooManyAttemptsError extends CredentialsSignin {
  code = "too-many-attempts";
}
