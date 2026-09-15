import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GET } from "./route";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { createUser } from "@/test/factories";
import { createVerificationToken } from "@/lib/auth/verificationTokens";

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("GET /api/auth/verify/[token]", () => {
  it("marks the address verified and redirects to a success state", async () => {
    const user = await createUser();
    const token = await createVerificationToken(user.email!);

    const response = await GET(new Request(`http://localhost/api/auth/verify/${token}`), ctx(token));

    expect(response.status).toBe(302); // Response.redirect's default
    expect(new URL(response.headers.get("Location")!).searchParams.get("status")).toBe("success");

    const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(row.emailVerified).not.toBeNull();
  });

  it("redirects to an invalid state for an unrecognized token, without touching any user", async () => {
    const response = await GET(
      new Request("http://localhost/api/auth/verify/not-a-real-token"),
      ctx("not-a-real-token")
    );

    expect(new URL(response.headers.get("Location")!).searchParams.get("status")).toBe("invalid");
  });

  it("still reports success for a valid token whose user no longer exists", async () => {
    // Defensive: the token's address matched no user row (the account was
    // deleted between issuing the link and it being clicked). The token is
    // still consumed; there's just nothing left to mark verified.
    const token = await createVerificationToken(`ghost-${crypto.randomUUID()}@example.com`);

    const response = await GET(new Request(`http://localhost/api/auth/verify/${token}`), ctx(token));

    expect(new URL(response.headers.get("Location")!).searchParams.get("status")).toBe("success");
  });

  it("is single-use: a second visit to the same link reports invalid", async () => {
    const user = await createUser();
    const token = await createVerificationToken(user.email!);

    await GET(new Request(`http://localhost/api/auth/verify/${token}`), ctx(token));
    const second = await GET(new Request(`http://localhost/api/auth/verify/${token}`), ctx(token));

    expect(new URL(second.headers.get("Location")!).searchParams.get("status")).toBe("invalid");
  });
});
