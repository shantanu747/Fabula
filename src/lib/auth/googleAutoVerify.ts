/**
 * Pure decision, split out of src/auth.ts's `signIn` callback so it's testable
 * without mocking Auth.js's full callback signature (docs/adr/0046). Google
 * vouches for the address it hands back — a Writer who signs in with Google
 * shouldn't face the same "can't share yet" gate a fresh Credentials signup
 * does, since there is no password-reset-shaped flow for them to verify
 * through in the first place.
 *
 * Only ever says yes to *marking* verified, never to un-marking it, and only
 * for Google — a Credentials sign-in is never routed through this at all.
 */
export function shouldAutoVerifyGoogleAccount(input: {
  provider: string | undefined;
  profileEmailVerified: boolean;
  userId: string | undefined;
  alreadyVerified: boolean;
}): boolean {
  return (
    input.provider === "google" &&
    input.profileEmailVerified === true &&
    input.userId !== undefined &&
    !input.alreadyVerified
  );
}
