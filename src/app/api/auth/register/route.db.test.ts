import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { users, verificationTokens } from "@/lib/db/schema";
import { neutralizeKvForEachTest } from "@/test/kv";
import { consoleMailer } from "@/lib/email/console";

neutralizeKvForEachTest();

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ name: "Test Writer", email: "writer@example.com", password: "a-real-password", ...body }),
  });
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // ConsoleMailer.send logs — silenced so test output stays readable.
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/register — origin", () => {
  it("rejects a cross-origin request", async () => {
    const request = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ name: "x", email: "x@example.com", password: "a-real-password" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });
});

describe("POST /api/auth/register — validation", () => {
  it("rejects a password over 72 bytes even though it's over 8 characters", async () => {
    const response = await POST(post({ password: "x".repeat(73) }));
    expect(response.status).toBe(400);
  });

  it("accepts a password at exactly 72 bytes", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const response = await POST(post({ email, password: "x".repeat(72) }));
    expect(response.status).toBe(201);
  });

  it("rejects an oversized name", async () => {
    const response = await POST(post({ name: "x".repeat(201) }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/auth/register — rate limiting", () => {
  it("rejects once REGISTER's capacity (5) is spent", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await POST(post({ email: `bucket-${i}-${crypto.randomUUID()}@example.com` }));
      expect(response.status).toBe(201);
    }
    const limited = await POST(post({ email: `bucket-6-${crypto.randomUUID()}@example.com` }));
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/auth/register — verification email", () => {
  it("sends a verification email for a genuinely new account", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const response = await POST(post({ email }));

    expect(response.status).toBe(201);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(email));

    const rows = await getDb().select().from(verificationTokens).where(eq(verificationTokens.identifier, email));
    expect(rows).toHaveLength(1);
  });

  it("still creates the account even when the mailer itself fails", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    vi.spyOn(consoleMailer, "send").mockRejectedValueOnce(new Error("mailer down"));

    const response = await POST(post({ email }));
    expect(response.status).toBe(201);

    const rows = await getDb().select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it("does not send a second email (or create a token) for an already-registered address", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    await POST(post({ email }));
    consoleLogSpy.mockClear();

    const second = await POST(post({ email, name: "A Different Name" }));

    // Uninformative response either way (ADR 0011) — still 201, no hint that
    // this branch was a no-op.
    expect(second.status).toBe(201);
    expect(consoleLogSpy).not.toHaveBeenCalled();

    const rows = await getDb().select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).not.toBe("A Different Name");
  });
});
