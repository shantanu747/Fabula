import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbForTests } from "@/lib/db/client";
import type { AppDatabase } from "@/lib/db/types";
import { guardGenerate, guardRegister } from "./guard";

/**
 * How the guard behaves when the database is unavailable or unhappy. Both are
 * decisions rather than accidents (docs/adr/0015), so both are pinned here.
 */

function request(ip = "203.0.113.7"): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

let originalUrl: string | undefined;

beforeEach(() => {
  originalUrl = process.env.DATABASE_URL;
  __setDbForTests(undefined);
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  __setDbForTests(undefined);
  vi.restoreAllMocks();
});

describe("with no database configured", () => {
  it.each([
    ["a guest generation", () => guardGenerate(request(), undefined)],
    ["a signed-in generation", () => guardGenerate(request(), "user-1")],
    ["a registration", () => guardRegister(request())],
  ])("allows %s and says so", async (_label, guard) => {
    // Guest writing has never required a database (docs/adr/0009), and rate
    // limiting must not quietly make Postgres a hard requirement for running
    // the app at all. Announced rather than silent: a limiter that is off
    // without anyone knowing is worse than no limiter.
    delete process.env.DATABASE_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(guard()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not being limited"));
  });
});

describe("when the bucket query fails", () => {
  function installFailingDb() {
    __setDbForTests({
      execute: async () => {
        throw new Error("database is down");
      },
    } as unknown as AppDatabase);
  }

  it("denies the request rather than letting it through", async () => {
    // Failing open would hand the whole provider budget to anyone able to make
    // the database unhappy, which inverts the point of the control. The cost is
    // real and accepted: an outage stops generation for guests.
    installFailingDb();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await guardGenerate(request(), undefined);

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("5");
  });

  it("does not blame the caller in the message", async () => {
    // This denial is the server's fault, and the copy should not tell someone
    // to slow down when they did nothing wrong.
    installFailingDb();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await guardRegister(request());

    await expect(response?.json()).resolves.toEqual({
      error: "Too busy right now. Try again in a moment.",
    });
  });
});
