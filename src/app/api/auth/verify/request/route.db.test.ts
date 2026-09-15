import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { users, verificationTokens } from "@/lib/db/schema";
import { createUser } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";
import { consoleMailer } from "@/lib/email/console";

function request(): Request {
  return new Request("http://localhost/api/auth/verify/request", {
    method: "POST",
    headers: { Origin: "http://localhost" },
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setTestSession(null);
  vi.restoreAllMocks();
});

describe("POST /api/auth/verify/request", () => {
  it("rejects an unauthenticated caller", async () => {
    setTestSession(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));
    const response = await POST(
      new Request("http://localhost/api/auth/verify/request", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("issues a token for an unverified Writer's own address", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id, { email: user.email!, verified: false }));

    const response = await POST(request());
    expect(response.status).toBe(200);

    const rows = await getDb().select().from(verificationTokens).where(eq(verificationTokens.identifier, user.email!));
    expect(rows).toHaveLength(1);
  });

  it("still returns ok when the mailer itself fails", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id, { email: user.email!, verified: false }));
    vi.spyOn(consoleMailer, "send").mockRejectedValueOnce(new Error("mailer down"));

    const response = await POST(request());
    expect(response.status).toBe(200);
  });

  it("is a no-op for an already-verified Writer — no token, no email", async () => {
    const user = await createUser();
    await getDb().update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    setTestSession(sessionForUser(user.id, { email: user.email!, verified: true }));

    const logSpy = vi.spyOn(console, "log");
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
    const rows = await getDb().select().from(verificationTokens).where(eq(verificationTokens.identifier, user.email!));
    expect(rows).toHaveLength(0);
  });
});
