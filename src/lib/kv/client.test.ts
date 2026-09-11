import { describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { __setKvForTests, getKv, hasKv, withKvTimeout } from "./client";
import { neutralizeKvForEachTest } from "@/test/kv";

// CI sets KV_REST_API_URL at the job level for the tests that need a real
// Redis (same ambient-env trap DATABASE_URL has — see route.test.ts's
// comment); this suite asserts on the "nothing configured" state directly, so
// it must not depend on that being absent.
neutralizeKvForEachTest();

describe("hasKv", () => {
  it("is false with nothing configured", () => {
    expect(hasKv()).toBe(false);
  });

  it("is true once a handle has been injected, even without env vars", () => {
    // Mirrors hasDatabase()'s reasoning: the test suite counts as configured
    // once it has injected a handle, regardless of env.
    __setKvForTests({} as never);
    expect(hasKv()).toBe(true);
  });
});

describe("getKv", () => {
  it("lazily constructs a real client from env when nothing has been injected", () => {
    process.env.KV_REST_API_URL = "http://localhost:8079";
    process.env.KV_REST_API_TOKEN = "dev";

    expect(getKv()).toBeInstanceOf(Redis);
  });

  it("returns the injected handle instead of constructing one", () => {
    const fake = {} as Redis;
    __setKvForTests(fake);

    expect(getKv()).toBe(fake);
  });
});

describe("__setKvForTests", () => {
  it("refuses to run in production", () => {
    // Guarded rather than compiled out, so misuse fails loudly instead of
    // silently swapping the backend underneath a live deployment — see
    // src/lib/db/client.ts's __setDbForTests for the identical pattern.
    const original = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");

    try {
      expect(() => __setKvForTests(undefined)).toThrow(/never be called in production/);
    } finally {
      vi.stubEnv("NODE_ENV", original ?? "test");
      vi.unstubAllEnvs();
    }
  });
});

describe("withKvTimeout", () => {
  it("returns the operation's result when it resolves in time", async () => {
    await expect(withKvTimeout(async () => "ok", 50)).resolves.toBe("ok");
  });

  it("resolves to undefined, not a rejection, when the operation throws", async () => {
    await expect(
      withKvTimeout(async () => {
        throw new Error("redis is down");
      }, 50)
    ).resolves.toBeUndefined();
  });

  it("resolves to undefined when the operation does not finish in time", async () => {
    const hang = new Promise<string>(() => {});
    await expect(withKvTimeout(() => hang, 10)).resolves.toBeUndefined();
  });
});
