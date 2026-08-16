import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { neonConfig } from "@neondatabase/serverless";
import { __setDbForTests, getAuthAdapterDb, getDb, hasDatabase } from "./client";
import type { AppDatabase } from "./types";

/**
 * The lazy-construction and test-seam behaviour of the database handle. No
 * connection is ever opened: the Neon driver builds its client eagerly but only
 * contacts the endpoint when a statement runs, so an unreachable host is enough.
 */

const UNREACHABLE = "postgres://user:pass@example.invalid/db";

let originalUrl: string | undefined;
let originalEndpoint: string | undefined;

beforeEach(() => {
  originalUrl = process.env.DATABASE_URL;
  originalEndpoint = process.env.NEON_FETCH_ENDPOINT;
  __setDbForTests(undefined);
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  if (originalEndpoint === undefined) delete process.env.NEON_FETCH_ENDPOINT;
  else process.env.NEON_FETCH_ENDPOINT = originalEndpoint;
  __setDbForTests(undefined);
});

describe("hasDatabase", () => {
  it("is false with no connection string and no injected handle", () => {
    // Guest writing has to keep working for someone who cloned the repo without
    // provisioning Postgres, so this is what the rate limiter checks before
    // deciding it has somewhere to keep a counter.
    delete process.env.DATABASE_URL;

    expect(hasDatabase()).toBe(false);
  });

  it("is true when a connection string is configured", () => {
    process.env.DATABASE_URL = UNREACHABLE;

    expect(hasDatabase()).toBe(true);
  });

  it("is true when a handle has been injected, even with no connection string", () => {
    // Which is what makes the db suite count as configured.
    delete process.env.DATABASE_URL;
    __setDbForTests({} as AppDatabase);

    expect(hasDatabase()).toBe(true);
  });
});

describe("getDb", () => {
  it("memoises the handle rather than reconnecting per call", () => {
    process.env.DATABASE_URL = UNREACHABLE;

    expect(getDb()).toBe(getDb());
  });

  it("constructs lazily, so a missing connection string fails at first use", () => {
    // Not at module load: that would break `next build` and `next dev` before a
    // developer has provisioned a database at all.
    delete process.env.DATABASE_URL;

    expect(() => getDb()).toThrow();
  });

  it("honours NEON_FETCH_ENDPOINT so the production driver can reach a local proxy", () => {
    // The Neon driver speaks Neon's HTTP protocol, not the Postgres wire
    // protocol, so this is the only way to run the real driver locally and
    // catch behaviour that differs from the node-postgres test driver.
    process.env.DATABASE_URL = UNREACHABLE;
    process.env.NEON_FETCH_ENDPOINT = "http://db.localtest.me:4444/sql";

    getDb();

    expect(neonConfig.fetchEndpoint).toBe("http://db.localtest.me:4444/sql");
  });
});

describe("getAuthAdapterDb", () => {
  it("returns a fresh full-featured handle for the Auth.js adapter", () => {
    // The adapter's types demand a complete PgDatabase, which AppDatabase
    // deliberately is not. This is the single sanctioned way around that, and it
    // must not hand back the memoised, narrowed handle.
    process.env.DATABASE_URL = UNREACHABLE;

    const adapterDb = getAuthAdapterDb();

    expect(adapterDb).toBeDefined();
    expect(adapterDb).not.toBe(getDb());
  });
});

describe("__setDbForTests", () => {
  it("replaces the handle", () => {
    const fake = {} as AppDatabase;

    __setDbForTests(fake);

    expect(getDb()).toBe(fake);
  });

  it("refuses to run in production", () => {
    // Guarded rather than compiled out, so misuse fails loudly instead of
    // silently swapping the driver underneath a live deployment.
    const original = process.env.NODE_ENV;
    // vi.stubEnv rather than assignment: NODE_ENV is a non-configurable
    // accessor on process.env under Vitest, so defineProperty throws.
    vi.stubEnv("NODE_ENV", "production");

    try {
      expect(() => __setDbForTests(undefined)).toThrow(/never be called in production/);
    } finally {
      vi.stubEnv("NODE_ENV", original ?? "test");
      vi.unstubAllEnvs();
    }
  });
});
