import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";
import { GET } from "./route";

function request(secret: string): Request {
  return new Request("http://localhost/api/cron/prune", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function insertBucket(key: string, ageHours: number) {
  await getDb()
    .insert(rateLimitBuckets)
    .values({ key, tokens: 5, updatedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000) });
}

describe("GET /api/cron/prune", () => {
  it("deletes only buckets untouched for over 24h", async () => {
    await insertBucket("prune:stale", 25);
    await insertBucket("prune:fresh", 1);
    process.env.CRON_SECRET = "test-secret";

    const response = await GET(request("test-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pruned: 1 });

    const remaining = await getDb().select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, "prune:fresh"));
    expect(remaining).toHaveLength(1);
    const gone = await getDb().select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, "prune:stale"));
    expect(gone).toHaveLength(0);
  });
});
