import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { __setDbForTests } from "@/lib/db/client";

function request(secret?: string): Request {
  return new Request("http://localhost/api/cron/prune", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.CRON_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  __setDbForTests(undefined);
});

describe("GET /api/cron/prune", () => {
  it("refuses to run when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(request("anything"));

    expect(response.status).toBe(503);
  });

  it("rejects a missing Authorization header", async () => {
    process.env.CRON_SECRET = "the-real-secret";

    const response = await GET(request());

    expect(response.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = "the-real-secret";

    const response = await GET(request("guessed-wrong"));

    expect(response.status).toBe(401);
  });

  it("rejects a secret of a different length than the real one", async () => {
    // The naive `timingSafeEqual` call throws on a length mismatch rather than
    // returning false — hashing both sides to a fixed digest length first
    // (route.ts's timingSafeEqualSecret) is what this test is pinning down.
    process.env.CRON_SECRET = "short";

    const response = await GET(request("a-much-longer-guessed-secret-string"));

    expect(response.status).toBe(401);
  });

  it("reports nothing pruned when no database is configured, rather than throwing", async () => {
    process.env.CRON_SECRET = "the-real-secret";
    delete process.env.DATABASE_URL;
    __setDbForTests(undefined);

    const response = await GET(request("the-real-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pruned: 0 });
  });
});
