import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { passwordResetTokens, users } from "@/lib/db/schema";
import { consoleMailer } from "@/lib/email/console";

function post(email: string): Request {
  return new Request("http://localhost/api/auth/password/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/password/request", () => {
  it("rejects a cross-origin request", async () => {
    const response = await POST(
      new Request("http://localhost/api/auth/password/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ email: "a@example.com" }),
      })
    );
    expect(response.status).toBe(403);
  });

  it("rejects a malformed body", async () => {
    const response = await POST(
      new Request("http://localhost/api/auth/password/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ email: 12345 }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("still returns the uninformative response when the mailer itself fails", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const passwordHash = await bcrypt.hash("old-password", 12);
    await getDb().insert(users).values({ email, passwordHash });
    vi.spyOn(consoleMailer, "send").mockRejectedValueOnce(new Error("mailer down"));

    const response = await POST(post(email));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: expect.any(String) });
  });

  it("returns the same response for an address that doesn't exist", async () => {
    const response = await POST(post(`nobody-${crypto.randomUUID()}@example.com`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: expect.any(String) });
  });

  it("returns the identical response for an address that does exist, and issues a token", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const passwordHash = await bcrypt.hash("old-password", 12);
    const [user] = await getDb().insert(users).values({ email, passwordHash }).returning();

    const response = await POST(post(email));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: expect.any(String) });

    const rows = await getDb().select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("does not send a reset email for a Google-only account (no password to reset)", async () => {
    const email = `google-${crypto.randomUUID()}@example.com`;
    const [user] = await getDb().insert(users).values({ email }).returning();

    const logSpy = vi.spyOn(console, "log");
    const response = await POST(post(email));

    expect(response.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
    const rows = await getDb().select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(0);
  });
});
