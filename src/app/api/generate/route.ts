import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs } from "@/lib/db/schema";
import { syncStoryParagraphs } from "@/lib/db/paragraphs";
import { insertAIParagraph } from "@/lib/db/paragraphs";
import { isUniqueViolation } from "@/lib/db/paragraphs";
import { MAX_OUTPUT_TOKENS } from "@/lib/providers/constants";
import { getProvider } from "@/lib/providers/registry";
import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import { 
  isStoryParagraphArray, 
  areValidHints, 
  isValidTargetLength 
} from "@/lib/story/validation";

interface GenerateRequestBody {
  providerId: string;
  storySoFar: StoryParagraph[];
  theme?: string;
  characters?: string;
  openingLines?: string;
  targetLength?: number;
  /** Present only for logged-in Writers who've saved this story (see api/stories).
   *  Guests, and logged-in Writers who haven't saved yet, omit this and get no
   *  server-side persistence — identical behavior to before persistence existed. */
  storyId?: string;
}

function isValidBody(body: unknown): body is GenerateRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.providerId === "string" &&
    // Element shape matters here, not just Array-ness: storySoFar is written straight
    // into story_paragraph below (authorType/text) and into the provider prompt.
    isStoryParagraphArray(b.storySoFar) &&
    areValidHints(b) &&
    (b.targetLength === undefined || isValidTargetLength(b.targetLength)) &&
    (b.storyId === undefined || typeof b.storyId === "string")
  );
}

// Strict one-turn-each policy, enforced server-side (not just a client UI gate):
// the AI may never generate two paragraphs in a row.
function isAIsTurn(storySoFar: StoryParagraph[]): boolean {
  if (storySoFar.length === 0) return true; // AI may write the very first paragraph (UC-2/UC-3)
  return storySoFar[storySoFar.length - 1].author !== "ai";
}

const METADATA_SENTINEL = "\n FABULA:METADATA ";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  // Rebind to a `const` so closures below (persistAIParagraph) keep the narrowed type —
  // TS widens `body` back to `unknown` inside closures because it's declared `let`.
  const input = body;

  const provider = getProvider(input.providerId);
  if (!provider) {
    return Response.json({ error: `Unknown provider: ${input.providerId}` }, { status: 400 });
  }

  if (!isAIsTurn(input.storySoFar)) {
    return Response.json(
      { error: "It's the Writer's turn — the AI can't generate two paragraphs in a row." },
      { status: 409 }
    );
  }

  // Write-through persistence: only for logged-in Writers who've already saved this
  // story (POST /api/stories). Diff-based against what's already stored, rather than
  // trusting the client to say which paragraphs are "new" (see ADR 0009).
  let persistedStoryId: string | undefined;
  let aiPosition: number;
  if (input.storyId) {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const db = getDb();
    const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId));
    if (!story || story.ownerId !== session.user.id) {
      return Response.json({ error: "Story not found" }, { status: 404 });
    }
    
    const sync = await syncStoryParagraphs(db, story.id, input.storySoFar);
    if (!sync.ok) {
      return Response.json(
        { error: "Story content has diverged from server state" },
        { status: 409 }
      );
    }
    
    persistedStoryId = story.id;
    aiPosition = sync.nextPosition;
  } else {
    // For guest path, derive AI position from client array length (unchanged behavior)
    aiPosition = input.storySoFar.length;
  }

  const iterator = provider.generateParagraph({
    storySoFar: input.storySoFar,
    theme: input.theme,
    characters: input.characters,
    openingLines: input.openingLines,
    targetLength: input.targetLength,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let first: IteratorResult<string, InventedMetadata | undefined>;
  try {
    // Pre-fetch the first chunk before committing to a streaming Response, so a bad
    // API key / invalid model / provider error surfaces as a clean 502 instead of a
    // broken 200 stream.
    first = await iterator.next();
  } catch (err) {
    console.error(`[generate] ${provider.id} failed before first chunk:`, err);
    return Response.json({ error: "Generation failed to start" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  let aiText = "";

  async function persistAIParagraph(metadata: InventedMetadata | undefined) {
    if (!persistedStoryId) return;
    const db = getDb();
    const wrote = await insertAIParagraph(db, {
      storyId: persistedStoryId, 
      text: aiText, 
      providerId: input.providerId,
      position: aiPosition, 
      invented: metadata,
    });
    if (!wrote) {
      console.warn(
        `[generate] story ${persistedStoryId} position ${aiPosition} was taken by a ` +
          `concurrent turn; this generation was superseded and not persisted.`
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (first.done) {
        await persistAIParagraph(first.value);
        if (first.value) {
          controller.enqueue(encoder.encode(METADATA_SENTINEL + JSON.stringify(first.value)));
        }
        controller.close();
      } else {
        aiText += first.value;
        controller.enqueue(encoder.encode(first.value));
      }
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          await persistAIParagraph(value);
          if (value) {
            controller.enqueue(encoder.encode(METADATA_SENTINEL + JSON.stringify(value)));
          }
          controller.close();
        } else {
          aiText += value;
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        console.error(`[generate] ${provider.id} stream error:`, err);
        // Deliberately swallowed. The prose already streamed to the Writer; turning a
        // persistence failure into a stream error makes the client auto-retry and pay
        // for a second generation of a paragraph that already succeeded. Losing the
        // mirror is the smaller loss.
        console.error(`[generate] failed to persist AI paragraph for ${persistedStoryId ?? "(guest)"}:`, err);
      }
    },
    async cancel(reason) {
      // The Writer's client discards the partial text too (streamGeneration returns
      // without onDone on abort), so dropping it here keeps both sides in sync. The
      // client's one auto-retry re-runs the whole turn; syncStoryParagraphs is
      // idempotent against the already-persisted Writer paragraphs, so the retry
      // appends nothing and simply regenerates the AI turn.
      console.info(`[generate] stream cancelled for story ${persistedStoryId ?? "(guest)"}:`, reason);
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}