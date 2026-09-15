import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";
import { neutralizeKvForEachTest } from "@/test/kv";
import { bucketKey } from "./policy";
import {
  GENERATE_GUEST,
  GENERATE_GUEST_UNIDENTIFIED,
  LOGIN_ACCOUNT,
  LOGIN_IP,
  PASSWORD_RESET_COMPLETE,
  PASSWORD_RESET_REQUEST_ACCOUNT,
  PASSWORD_RESET_REQUEST_IP,
  VERIFY_REQUEST,
} from "./policy";
import { guardGenerate, guardLogin, guardPasswordResetComplete, guardPasswordResetRequest, guardVerifyRequest } from "./guard";

// Asserts directly against `rate_limit_bucket` rows, so this must exercise
// the Postgres path regardless of whether a real Redis is configured for the
// run — see store.db.test.ts's identical guard.
neutralizeKvForEachTest();

function requestWithNoProxyHeaders(): Request {
  return new Request("http://localhost/api/generate", { method: "POST" });
}

function requestWithIp(ip: string): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

async function bucketExists(key: string): Promise<boolean> {
  const rows = await getDb().select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, key));
  return rows.length > 0;
}

describe("guardGenerate — bucket routing against a real Postgres", () => {
  it("writes an identified guest's bucket under GENERATE_GUEST's scope", async () => {
    await guardGenerate(requestWithIp("203.0.113.50"), undefined);

    expect(await bucketExists(bucketKey(GENERATE_GUEST, "203.0.113.50"))).toBe(true);
    expect(await bucketExists(bucketKey(GENERATE_GUEST_UNIDENTIFIED, "203.0.113.50"))).toBe(false);
  });

  it("writes a no-signal guest's bucket under the stricter, shared scope instead", async () => {
    await guardGenerate(requestWithNoProxyHeaders(), undefined);

    expect(await bucketExists(bucketKey(GENERATE_GUEST_UNIDENTIFIED, "unknown"))).toBe(true);
    expect(await bucketExists(bucketKey(GENERATE_GUEST, "unknown"))).toBe(false);
  });
});

describe("guardLogin — two independent buckets (docs/adr/0046)", () => {
  it("writes both an IP bucket and an account bucket for a single attempt", async () => {
    await guardLogin(requestWithIp("198.51.100.9"), "writer@example.com");

    expect(await bucketExists(bucketKey(LOGIN_IP, "198.51.100.9"))).toBe(true);
    expect(await bucketExists(bucketKey(LOGIN_ACCOUNT, "writer@example.com"))).toBe(true);
  });

  it("denies once the per-account bucket is spent, even from a fresh IP each time", async () => {
    // LOGIN_ACCOUNT's capacity is 5 — a botnet spraying one account from many
    // addresses must still be stopped, which an IP-only limit could not do.
    for (let i = 0; i < 5; i++) {
      const result = await guardLogin(requestWithIp(`198.51.100.${i}`), "target@example.com");
      expect(result).toBeNull();
    }

    const denied = await guardLogin(requestWithIp("198.51.100.99"), "target@example.com");
    expect(denied?.status).toBe(429);
  });

  it("denies once the per-IP bucket is spent, even against many different accounts", async () => {
    // LOGIN_IP's capacity is 10 — one attacker spraying many accounts from a
    // single address must still be stopped, which an account-only limit
    // could not do.
    for (let i = 0; i < 10; i++) {
      const result = await guardLogin(requestWithIp("198.51.100.200"), `victim-${i}@example.com`);
      expect(result).toBeNull();
    }

    const denied = await guardLogin(requestWithIp("198.51.100.200"), "victim-new@example.com");
    expect(denied?.status).toBe(429);
  });
});

describe("guardVerifyRequest / guardPasswordResetComplete — single bucket", () => {
  it("guardVerifyRequest is keyed by account, not address", async () => {
    await guardVerifyRequest("user-42");
    expect(await bucketExists(bucketKey(VERIFY_REQUEST, "user-42"))).toBe(true);
  });

  it("guardPasswordResetComplete is keyed by address", async () => {
    await guardPasswordResetComplete(requestWithIp("203.0.113.20"));
    expect(await bucketExists(bucketKey(PASSWORD_RESET_COMPLETE, "203.0.113.20"))).toBe(true);
  });
});

describe("guardPasswordResetRequest — two independent buckets", () => {
  it("writes both an IP bucket and an account bucket for a single request", async () => {
    await guardPasswordResetRequest(requestWithIp("198.51.100.30"), "forgetful@example.com");

    expect(await bucketExists(bucketKey(PASSWORD_RESET_REQUEST_IP, "198.51.100.30"))).toBe(true);
    expect(await bucketExists(bucketKey(PASSWORD_RESET_REQUEST_ACCOUNT, "forgetful@example.com"))).toBe(true);
  });
});
