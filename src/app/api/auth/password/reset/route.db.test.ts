import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { createPasswordResetToken } from "@/lib/auth/passwordResetTokens";
import { getCurrentTokenVersion } from "@/lib/auth/tokenVersion";

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/auth/password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function createUser(password = "old-password") {
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await getDb().insert(users).values({ email: `writer-${crypto.randomUUID()}@example.com`, passwordHash }).returning();
  return user;
}

describe("POST /api/auth/password/reset", () => {
  it("rejects a cross-origin request", async () => {
    const response = await POST(
      new Request("http://localhost/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ token: "x", password: "new-password-1" }),
      })
    );
    expect(response.status).toBe(403);
  });

  it("rejects a malformed body", async () => {
    const response = await POST(post({ token: "", password: "short" }));
    expect(response.status).toBe(400);
  });

  it("rejects an invalid or unknown token", async () => {
    const response = await POST(post({ token: "not-a-real-token", password: "new-password-1" }));
    expect(response.status).toBe(400);
  });

  it("rejects a password over 72 bytes", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);
    const response = await POST(post({ token, password: "x".repeat(73) }));
    expect(response.status).toBe(400);
  });

  it("sets the new password and bumps tokenVersion, invalidating existing sessions", async () => {
    const user = await createUser("old-password");
    const token = await createPasswordResetToken(user.id);

    const response = await POST(post({ token, password: "brand-new-password" }));
    expect(response.status).toBe(200);

    const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(await bcrypt.compare("brand-new-password", row.passwordHash!)).toBe(true);
    expect(await bcrypt.compare("old-password", row.passwordHash!)).toBe(false);

    expect(await getCurrentTokenVersion(user.id)).toBe(1);
  });

  it("is single-use: replaying the same reset request fails", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    await POST(post({ token, password: "first-new-password" }));
    const replay = await POST(post({ token, password: "second-new-password" }));

    expect(replay.status).toBe(400);
  });
});
