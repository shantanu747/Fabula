import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/__bench/roundtrips", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is absent (404) without BENCH_INSTRUMENTATION=1", async () => {
    vi.stubEnv("BENCH_INSTRUMENTATION", "");
    const response = await GET();
    expect(response.status).toBe(404);
  });

  it("is absent (404) when BENCH_INSTRUMENTATION is set to something other than \"1\"", async () => {
    vi.stubEnv("BENCH_INSTRUMENTATION", "true");
    const response = await GET();
    expect(response.status).toBe(404);
  });

  it("returns counts and resets them when explicitly enabled", async () => {
    vi.stubEnv("BENCH_INSTRUMENTATION", "1");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, number>;
    expect(body).toHaveProperty("select");
    expect(body).toHaveProperty("insert");
    expect(body).toHaveProperty("update");
    expect(body).toHaveProperty("execute");
    expect(body).toHaveProperty("total");
  });
});
