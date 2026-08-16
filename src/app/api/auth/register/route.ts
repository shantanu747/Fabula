import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { guardRegister } from "@/lib/ratelimit/guard";

interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

function isValidBody(body: unknown): body is RegisterBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === "string" &&
    b.name.trim().length > 0 &&
    typeof b.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
    typeof b.password === "string" &&
    b.password.length >= 8
  );
}

// The Credentials provider (src/auth.ts) has no built-in signup — this endpoint creates
// the user row it later authenticates against. The client calls signIn("credentials", …)
// immediately after a successful response here.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return Response.json(
      { error: "Name, a valid email, and a password of at least 8 characters are required." },
      { status: 400 }
    );
  }

  // Before bcrypt, which is the expensive part of this handler and therefore the
  // part worth protecting from being invoked in a loop.
  const limited = await guardRegister(request);
  if (limited) return limited;

  // Deliberately indistinguishable whether or not the email is already registered:
  // a "that account exists" response would let anyone probe which addresses have a
  // Fabula account. Hashing happens before the insert either way so the bcrypt cost
  // (the dominant term in this handler's latency) doesn't leak the answer by timing.
  const passwordHash = await bcrypt.hash(body.password, 12);

  // onConflictDoNothing rather than a select-then-insert: atomic against a concurrent
  // signup for the same address, and it can't clobber an existing account's password.
  // The client's follow-up signIn() is what actually decides whether the caller gets a
  // session, so a silent no-op here is safe.
  await getDb()
    .insert(users)
    .values({ name: body.name, email: body.email, passwordHash })
    .onConflictDoNothing({ target: users.email });

  return Response.json({ ok: true }, { status: 201 });
}
