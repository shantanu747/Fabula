import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { insertAIParagraph, syncStoryParagraphs } from "@/lib/db/paragraphs";
import { guardGenerate } from "@/lib/ratelimit/guard";
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
  // TEMPORARY (remove once ADR 0020's open question is answered): guest-write.spec.ts's
  // first test intermittently sits stuck for 15s+ in CI with no visible client-side
  // network activity before the whole paragraph appears at once. The client renders the
  // "isStreaming" attribution optimistically (src/app/story/page.tsx), so a stall here —
  // before the Response (and its headers) is ever returned — is invisible to the browser
  // as anything but a pending fetch. These timestamps exist to find out which await it is.
  const t0 = Date.now();
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

  // Resolved once, for every request rather than only the persisted ones, because
  // it decides which rate-limit bucket applies. With JWT sessions this verifies a
  // cookie signature and makes no database call (docs/adr/0009), so it is cheap
  // enough to do unconditionally.
  const session = await auth();
  console.log(`[generate:timing] auth() resolved at +${Date.now() - t0}ms`);

  // Last gate before anything costs money. Deliberately after validation and the
  // turn check — a malformed or out-of-turn request never reaches a provider, so
  // spending a token on it would only punish a buggy client.
  const limited = await guardGenerate(request, session?.user?.id);
  console.log(`[generate:timing] guardGenerate resolved at +${Date.now() - t0}ms`);
  if (limited) return limited;

  // Write-through persistence: only for logged-in Writers who've already saved this
  // story (POST /api/stories). Diff-based against what's already stored, rather than
  // trusting the client to say which paragraphs are "new" (see ADR 0009).
  let persistedStoryId: string | undefined;
  let aiPosition: number;
  if (input.storyId) {
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
    console.log(`[generate:timing] iterator.next() (first chunk) starting at +${Date.now() - t0}ms`);
    first = await iterator.next();
    console.log(`[generate:timing] iterator.next() (first chunk) resolved at +${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`[generate:timing] iterator.next() (first chunk) threw at +${Date.now() - t0}ms`);
    console.error(`[generate] ${provider.id} failed before first chunk:`, err);
    return Response.json({ error: "Generation failed to start" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  let aiText = "";

  async function persistAIParagraph(metadata: InventedMetadata | undefined) {
    if (!persistedStoryId) return;
    try {
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
    } catch (err) {
      // Deliberately swallowed, and scoped to persistence alone. The prose has
      // already streamed to the Writer; turning a mirror-write failure into a
      // stream error would make the client auto-retry and pay for a second
      // generation of a paragraph that already succeeded. Losing the mirror is
      // the smaller loss. Provider failures are NOT swallowed — see pull().
      console.error(
        `[generate] failed to persist AI paragraph for ${persistedStoryId}:`,
        err
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
        // A provider failure mid-stream has to reach the client. The client maps
        // a broken stream to "stream-aborted" and runs its single auto-retry;
        // closing the stream normally instead would hand the Writer a truncated
        // paragraph presented as a finished one, with nothing to retry from.
        controller.error(err);
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

  console.log(`[generate:timing] returning Response at +${Date.now() - t0}ms`);
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}