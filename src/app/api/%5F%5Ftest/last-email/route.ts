import { __getSentEmailsForTests } from "@/lib/email/console";
import { withRoute } from "@/lib/observability/withRoute";

/**
 * E2E-only recovery of the verification/reset link ConsoleMailer "sent"
 * (docs/adr/0046) — the token itself is stored hashed, so there is no other
 * way for a Playwright spec to find out what it was.
 *
 * Gated on E2E_TEST_MODE, mirroring `%5F%5Fbench/roundtrips`'s
 * BENCH_INSTRUMENTATION gate exactly: never set outside a Playwright run
 * (e2e/playwright.config.ts), so this 404s — indistinguishable from a route
 * that doesn't exist — in a normal build or deployment. Same private-folder
 * naming trick as that route: `%5F` is the escape hatch for a path segment
 * that must start with a literal underscore on the wire.
 */
export const GET = withRoute("/api/__test/last-email", async (request: Request): Promise<Response> => {
  if (process.env.E2E_TEST_MODE !== "1") {
    return new Response(null, { status: 404 });
  }

  const to = new URL(request.url).searchParams.get("to");
  if (!to) return new Response(null, { status: 400 });

  const match = [...__getSentEmailsForTests()].reverse().find((email) => email.to === to);
  if (!match) return new Response(null, { status: 404 });

  return Response.json({ subject: match.subject, text: match.text });
});
