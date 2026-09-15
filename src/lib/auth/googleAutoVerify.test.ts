import { describe, expect, it } from "vitest";
import { shouldAutoVerifyGoogleAccount } from "./googleAutoVerify";

const base = {
  provider: "google",
  profileEmailVerified: true,
  userId: "user-1",
  alreadyVerified: false,
};

describe("shouldAutoVerifyGoogleAccount", () => {
  it("verifies a first-time Google sign-in whose profile says the email is verified", () => {
    expect(shouldAutoVerifyGoogleAccount(base)).toBe(true);
  });

  it("never verifies a non-Google provider", () => {
    expect(shouldAutoVerifyGoogleAccount({ ...base, provider: "credentials" })).toBe(false);
  });

  it("never verifies when Google's own profile says the email is unverified", () => {
    expect(shouldAutoVerifyGoogleAccount({ ...base, profileEmailVerified: false })).toBe(false);
  });

  it("never verifies when the profile omits email_verified entirely (coerced to false at the call site)", () => {
    expect(shouldAutoVerifyGoogleAccount({ ...base, profileEmailVerified: false })).toBe(false);
  });

  it("never verifies without a user id", () => {
    expect(shouldAutoVerifyGoogleAccount({ ...base, userId: undefined })).toBe(false);
  });

  it("is a no-op (false) once already verified — never re-writes, only ever sets", () => {
    expect(shouldAutoVerifyGoogleAccount({ ...base, alreadyVerified: true })).toBe(false);
  });
});
