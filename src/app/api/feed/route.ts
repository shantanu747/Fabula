import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { decodeCursor, getFeedPage } from "@/lib/db/feedAndLibrary";
import { PRIVATE_NO_STORE } from "@/lib/http/cacheControl";
import { guardFeedRead } from "@/lib/ratelimit/guard";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardFeedRead(session.user.id);
  if (limited) return limited;

  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("cursor");
  // Opaque to the client (docs/plans/v4/03) — a cursor that doesn't decode
  // cleanly is a malformed request, not a page boundary to guess at.
  const cursor = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (rawCursor !== null && cursor === undefined) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }

  const { rows, nextCursor } = await getFeedPage(getDb(), cursor);
  return Response.json({ stories: rows, nextCursor }, { headers: { "Cache-Control": PRIVATE_NO_STORE } });
}
