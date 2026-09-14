import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { authorizeCredentials, __resetDummyPasswordHashForTests } from "./authorize";
import { TooManyAttemptsError } from "./errors";
import { neutralizeKvForEachTest } from "@/test/kv";

/**
 * Extracted from src/auth.ts's Credentials provider (docs/adr/0046) so the
 * login-rate-limit and timing-safety properties can be exercised directly.
 * Runs against a real Postgres — it selects the user row via the fluent
 * query builder, the same reason every other Drizzle-fluent module in this
 * suite lives in the db project rather than being faked.
 */

neutralizeKvForEachTest();

function request(): Request {
  return new Request("http://localhost/api/auth/callback/credentials", { method: "POST" });
}

async function createCredentialsUser(email: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await getDb().insert(users).values({ email, name: "Test Writer", passwordHash }).returning();
  return user;
}

beforeEach(() => {
  __resetDummyPasswordHashForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorizeCredentials — happy path", () => {
  it("returns the user, including tokenVersion and emailVerified, on a correct password", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const user = await createCredentialsUser(email, "correct horse battery staple");

    const result = await authorizeCredentials({ email, password: "correct horse battery staple" }, request());

    expect(result).toMatchObject({ id: user.id, email, tokenVersion: 0, emailVerified: null });
  });
});

describe("authorizeCredentials — rejection paths", () => {
  it("returns null for a non-existent address", async () => {
    const result = await authorizeCredentials(
      { email: `nobody-${crypto.randomUUID()}@example.com`, password: "whatever12" },
      request()
    );
    expect(result).toBeNull();
  });

  it("returns null for a wrong password", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    await createCredentialsUser(email, "the-real-password");

    const result = await authorizeCredentials({ email, password: "wrong-password" }, request());
    expect(result).toBeNull();
  });

  it("returns null (never authorize.ts's own error) for a Google-only account with no password hash", async () => {
    const email = `google-only-${crypto.randomUUID()}@example.com`;
    await getDb().insert(users).values({ email, name: "Google Writer" });

    const result = await authorizeCredentials({ email, password: "anything12" }, request());
    expect(result).toBeNull();
  });

  it("returns null for non-string credentials without touching the rate limiter", async () => {
    const result = await authorizeCredentials({ email: 12345, password: undefined }, request());
    expect(result).toBeNull();
  });
});

describe("authorizeCredentials — timing uniformity (docs/adr/0011's posture, extended)", () => {
  it("calls bcrypt.compare exactly once whether or not the account exists", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare");

    await authorizeCredentials({ email: `ghost-${crypto.randomUUID()}@example.com`, password: "x" }, request());
    expect(compareSpy).toHaveBeenCalledTimes(1);

    compareSpy.mockClear();
    const email = `real-${crypto.randomUUID()}@example.com`;
    await createCredentialsUser(email, "a-real-password");
    await authorizeCredentials({ email, password: "wrong" }, request());
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });
});

describe("authorizeCredentials — login rate limiting", () => {
  it("throws TooManyAttemptsError once the per-account bucket is spent, rejecting even a correct password", async () => {
    const email = `bucket-${crypto.randomUUID()}@example.com`;
    await createCredentialsUser(email, "correct-password");

    // LOGIN_ACCOUNT's capacity is 5 (src/lib/ratelimit/policy.ts) — five
    // attempts spend the bucket, whether or not each one was correct.
    for (let i = 0; i < 5; i++) {
      await authorizeCredentials({ email, password: "wrong" }, request());
    }

    await expect(authorizeCredentials({ email, password: "correct-password" }, request())).rejects.toThrow(
      TooManyAttemptsError
    );
  });

  it("carries a client-safe code distinct from a wrong-password rejection", async () => {
    const email = `code-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 5; i++) {
      await authorizeCredentials({ email, password: "x" }, request());
    }

    try {
      await authorizeCredentials({ email, password: "x" }, request());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TooManyAttemptsError);
      expect((err as TooManyAttemptsError).code).toBe("too-many-attempts");
    }
  });
});
