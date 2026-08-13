import { count, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs } from "@/lib/db/schema";
import { areValidHints, isValidTargetLength } from "@/lib/story/validation";

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

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const rows = await getDb()
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      targetLength: stories.targetLength,
      isShared: stories.isShared,
      createdAt: stories.createdAt,
      updatedAt: stories.updatedAt,
      paragraphCount: count(storyParagraphs.id),
    })
    .from(stories)
    .leftJoin(storyParagraphs, eq(storyParagraphs.storyId, stories.id))
    .where(eq(stories.ownerId, session.user.id))
    .groupBy(stories.id)
    .orderBy(desc(stories.updatedAt));

  return Response.json({ stories: rows });
}
