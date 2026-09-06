import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { __setDbForTests } from "@/lib/db/client";
import type { AppDatabase } from "@/lib/db/types";

function healthRequest(): Request {
  return new Request("http://localhost/api/health");
}

const ENV_KEYS = ["DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  // CI sets all three provider keys at job level (ci.yml) — a test that
  // assumes they're unset can pass locally and fail in CI, or vice versa here,
  // the same trap AGENTS.md calls out for DATABASE_URL. Save and clear all
  // four so this suite's "false" assertions test its own logic, not whichever
  // shell happened to run it.
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  __setDbForTests(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  __setDbForTests(undefined);
  vi.restoreAllMocks();
});

describe("GET /api/health — database", () => {
  it("reports not-configured (and stays 200) with no database at all", async () => {
    // Guest writing has never required a database (docs/adr/0009) — a health
    // check that treated this as unhealthy would contradict that on every
    // "clone it and try the guest flow" environment.
    const response = await GET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.database).toBe("not-configured");
  });

  it("reports ok when the database answers", async () => {
    __setDbForTests({
      execute: async () => ({ rows: [{ tokens: 999 }] }),
    } as unknown as AppDatabase);

    const response = await GET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.database).toBe("ok");
  });

  it("reports unreachable (and degrades to 503) when the database errors", async () => {
    __setDbForTests({
      execute: async () => {
        throw new Error("connection refused");
      },
    } as unknown as AppDatabase);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("unreachable");
  });

  it("reports unreachable when the check exceeds its timeout", async () => {
    vi.useFakeTimers();
    // guardHealth's own rate-limit bucket check (consumeToken) hits this same
    // injected db first, on every call — only the health check's own SELECT 1
    // (the second call) should hang, or the request never gets past the
    // limiter at all and this test would be exercising a pre-existing,
    // out-of-scope gap (an unbounded rate-limit check) instead of the health
    // route's own 2s timeout.
    let calls = 0;
    __setDbForTests({
      execute: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ tokens: 999 }] };
        return new Promise(() => {}); // the health check's SELECT 1 — never resolves
      },
    } as unknown as AppDatabase);

    const responsePromise = GET(healthRequest());
    await vi.advanceTimersByTimeAsync(2000);
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.database).toBe("unreachable");
    vi.useRealTimers();
  });
});

describe("GET /api/health — providers", () => {
  it("reports each registered provider id with a boolean for key presence, never the key itself", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-super-secret-value";

    const response = await GET(healthRequest());
    const body = await response.json();

    expect(body.checks.providers).toMatchObject({
      anthropic: true,
      openai: false,
      openrouter: false,
    });
    expect(JSON.stringify(body)).not.toContain("sk-super-secret-value");
  });

  it("reports false for a provider whose key env var is an empty string", async () => {
    process.env.ANTHROPIC_API_KEY = "";

    const response = await GET(healthRequest());
    const body = await response.json();

    expect(body.checks.providers.anthropic).toBe(false);
  });
});

describe("GET /api/health — response shape", () => {
  it("never caches, and reports a version string", async () => {
    const response = await GET(healthRequest());

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
  });
});
