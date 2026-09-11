import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";
import { neutralizeKvForEachTest } from "@/test/kv";
import { bucketKey } from "./policy";
import { GENERATE_GUEST, GENERATE_GUEST_UNIDENTIFIED } from "./policy";
import { guardGenerate } from "./guard";

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
