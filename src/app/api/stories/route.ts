import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { decodeCursor, getLibraryPage } from "@/lib/db/feedAndLibrary";
import { PRIVATE_NO_STORE } from "@/lib/http/cacheControl";
import { areValidHints, isValidTargetLength } from "@/lib/story/validation";
import { guardStoriesRead, guardStoriesWrite } from "@/lib/ratelimit/guard";

interface CreateStoryBody {
  theme?: string;
  characters?: string;
  openingLines?: string;
  targetLength: number;
  selectedProviderId: string;
}

function isValidBody(body: unknown): body is CreateStoryBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    areValidHints(b) && isValidTargetLength(b.targetLength) && typeof b.selectedProviderId === "string"
  );
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardStoriesWrite(session.user.id);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const [story] = await getDb()
    .insert(stories)
    .values({
      ownerId: session.user.id,
      theme: body.theme,
      characters: body.characters,
      openingLines: body.openingLines,
      targetLength: body.targetLength,
      selectedProviderId: body.selectedProviderId,
    })
    .returning({ id: stories.id });

  return Response.json({ id: story.id }, { status: 201 });
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardStoriesRead(session.user.id);
  if (limited) return limited;

  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (rawCursor !== null && cursor === undefined) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }

  const { rows, nextCursor } = await getLibraryPage(getDb(), session.user.id, cursor);
  return Response.json({ stories: rows, nextCursor }, { headers: { "Cache-Control": PRIVATE_NO_STORE } });
}
