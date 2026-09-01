import { eq } from "drizzle-orm";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { auth } from "@/auth";
import { getDb, hasDatabase } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { insertAIParagraph, syncStoryParagraphs } from "@/lib/db/paragraphs";
import { insertGenerationEvent } from "@/lib/db/generationEvents";
import { guardGenerate } from "@/lib/ratelimit/guard";
import { MAX_OUTPUT_TOKENS } from "@/lib/providers/constants";
import { getProvider } from "@/lib/providers/registry";
import { estimateCostUsd } from "@/lib/providers/pricing";
import type { GenerationResult, InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { resolveRequestId } from "@/lib/observability/requestId";
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

const tracer = trace.getTracer("fabula");

/** Attaches x-request-id to any Response, including ones built elsewhere (guardGenerate's 429). */
function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("x-request-id", requestId);
  return response;
}

type Outcome = "success" | "provider_error" | "cancelled" | "persist_failed";

interface FinishArgs {
  outcome: Outcome;
  persisted: boolean;
  result?: GenerationResult;
  ttftMs?: number;
  totalMs: number;
  err?: unknown;
}

export async function POST(request: Request) {
  // TEMPORARY (remove once ADR 0021's open question is answered): reinstated from
  // commit c5c61c5 (reverted in 067e96b after one clean run proved nothing — see
  // ADR 0021) now that the flake has recurred on this branch's own PR, twice.
  // guest-write.spec.ts's first test intermittently sits stuck at the streaming
  // attribution placeholder for the full 15s expect timeout in CI, then the
  // paragraph is found fully complete — the generation finishes, just very late,
  // invisibly to the browser (which renders "isStreaming" optimistically on
  // submit, not on first byte). These timestamps exist to find out which await it
  // is, instead of another guess from interleaved [WebServer] log text (the
  // mistake ADR 0020 exists to stop repeating). Left in place — not reverted after
  // a clean run — until CI actually reproduces the stall with these active.
  const t0 = Date.now();
  const requestId = resolveRequestId(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withRequestId(Response.json({ error: "Invalid JSON body" }, { status: 400 }), requestId);
  }
  if (!isValidBody(body)) {
    return withRequestId(
      Response.json({ error: "Invalid request body" }, { status: 400 }),
      requestId
    );
  }
  // Rebind to a `const` so closures below (persistAIParagraph) keep the narrowed type —
  // TS widens `body` back to `unknown` inside closures because it's declared `let`.
  const input = body;

  const provider = getProvider(input.providerId);
  if (!provider) {
    return withRequestId(
      Response.json({ error: `Unknown provider: ${input.providerId}` }, { status: 400 }),
      requestId
    );
  }

  if (!isAIsTurn(input.storySoFar)) {
    return withRequestId(
      Response.json(
        { error: "It's the Writer's turn — the AI can't generate two paragraphs in a row." },
        { status: 409 }
      ),
      requestId
    );
  }

  // Resolved once, for every request rather than only the persisted ones, because
  // it decides which rate-limit bucket applies. With JWT sessions this verifies a
  // cookie signature and makes no database call (docs/adr/0009), so it is cheap
  // enough to do unconditionally.
  const session = await auth();
  const authenticated = Boolean(session?.user?.id);
  console.log(`[generate:timing] auth() resolved at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021

  // Last gate before anything costs money. Deliberately after validation and the
  // turn check — a malformed or out-of-turn request never reaches a provider, so
  // spending a token on it would only punish a buggy client.
  const limited = await guardGenerate(request, session?.user?.id);
  console.log(`[generate:timing] guardGenerate resolved at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021
  if (limited) {
    log.warn(LOG_EVENTS.RATELIMIT_REJECTED, { requestId, providerId: input.providerId, authenticated });
    return withRequestId(limited, requestId);
  }

  // Write-through persistence: only for logged-in Writers who've already saved this
  // story (POST /api/stories). Diff-based against what's already stored, rather than
  // trusting the client to say which paragraphs are "new" (see ADR 0009).
  let persistedStoryId: string | undefined;
  let aiPosition: number;
  if (input.storyId) {
    if (!session?.user?.id) {
      return withRequestId(Response.json({ error: "Not authenticated" }, { status: 401 }), requestId);
    }
    const db = getDb();
    const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId));
    if (!story || story.ownerId !== session.user.id) {
      return withRequestId(Response.json({ error: "Story not found" }, { status: 404 }), requestId);
    }

    const sync = await syncStoryParagraphs(db, story.id, input.storySoFar);
    if (!sync.ok) {
      return withRequestId(
        Response.json({ error: "Story content has diverged from server state" }, { status: 409 }),
        requestId
      );
    }

    persistedStoryId = story.id;
    aiPosition = sync.nextPosition;
  } else {
    // For guest path, derive AI position from client array length (unchanged behavior)
    aiPosition = input.storySoFar.length;
  }

  const startedAtMs = Date.now();
  const span = tracer.startSpan("fabula.generate", {
    attributes: {
      "gen_ai.system": provider.id,
      "fabula.authenticated": authenticated,
      "fabula.paragraph_count": input.storySoFar.length,
      ...(persistedStoryId ? { "fabula.story_id": persistedStoryId } : {}),
    },
  });

  log.info(LOG_EVENTS.GENERATE_STARTED, {
    requestId,
    providerId: input.providerId,
    authenticated,
    ...(persistedStoryId ? { storyId: persistedStoryId } : {}),
  });

  /** Ends the span and best-effort writes the durable cost-history row (docs/adr/0022). */
  async function finish(args: FinishArgs) {
    span.setAttributes({
      "fabula.outcome": args.outcome,
      "fabula.persisted": args.persisted,
      "fabula.total_ms": args.totalMs,
      ...(args.ttftMs !== undefined ? { "fabula.ttft_ms": args.ttftMs } : {}),
      ...(args.result?.model ? { "gen_ai.request.model": args.result.model } : {}),
      ...(args.result?.usage
        ? {
            "gen_ai.usage.input_tokens": args.result.usage.inputTokens,
            "gen_ai.usage.output_tokens": args.result.usage.outputTokens,
          }
        : {}),
    });
    const costUsd = args.result?.usage
      ? estimateCostUsd(args.result.model, args.result.usage)
      : undefined;
    if (costUsd !== undefined) span.setAttribute("fabula.cost_usd", costUsd);
    if (args.outcome === "provider_error" || args.outcome === "cancelled") {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();

    const logFields = {
      requestId,
      providerId: input.providerId,
      outcome: args.outcome,
      totalMs: args.totalMs,
      ...(args.ttftMs !== undefined ? { ttftMs: args.ttftMs } : {}),
      ...(args.result?.model ? { model: args.result.model } : {}),
      ...(args.result?.usage
        ? { inputTokens: args.result.usage.inputTokens, outputTokens: args.result.usage.outputTokens }
        : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(args.err !== undefined ? { err: args.err } : {}),
    };
    if (args.outcome === "provider_error") log.error(LOG_EVENTS.GENERATE_FAILED, logFields);
    else if (args.outcome === "cancelled") log.info(LOG_EVENTS.GENERATE_CANCELLED, logFields);
    else log.info(LOG_EVENTS.GENERATE_COMPLETED, logFields);

    // Not-configured is the valid "clone it and try the guest flow" deployment
    // (docs/adr/0009) — skip silently rather than logging a PERSIST_FAILED for
    // every single guest generation. Best-effort otherwise, deliberately
    // swallowed on a real failure: losing a cost-history row must never surface
    // as a stream error.
    if (!hasDatabase()) return;
    try {
      const db = getDb();
      await insertGenerationEvent(db, {
        requestId,
        providerId: input.providerId,
        model: args.result?.model ?? "unknown",
        userId: session?.user?.id,
        storyId: persistedStoryId,
        inputTokens: args.result?.usage?.inputTokens,
        outputTokens: args.result?.usage?.outputTokens,
        costUsd,
        ttftMs: args.ttftMs,
        totalMs: args.totalMs,
        outcome: args.outcome,
      });
    } catch (err) {
      log.error(LOG_EVENTS.PERSIST_FAILED, { requestId, reason: "generation_event", err });
    }
  }

  const iterator = provider.generateParagraph({
    storySoFar: input.storySoFar,
    theme: input.theme,
    characters: input.characters,
    openingLines: input.openingLines,
    targetLength: input.targetLength,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let first: IteratorResult<string, GenerationResult>;
  try {
    // Pre-fetch the first chunk before committing to a streaming Response, so a bad
    // API key / invalid model / provider error surfaces as a clean 502 instead of a
    // broken 200 stream.
    console.log(`[generate:timing] iterator.next() (first chunk) starting at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021
    first = await iterator.next();
    console.log(`[generate:timing] iterator.next() (first chunk) resolved at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021
  } catch (err) {
    console.log(`[generate:timing] iterator.next() (first chunk) threw at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021
    await finish({
      outcome: "provider_error",
      persisted: false,
      totalMs: Date.now() - startedAtMs,
      err,
    });
    return withRequestId(
      Response.json({ error: "Generation failed to start" }, { status: 502 }),
      requestId
    );
  }
  const ttftMs = Date.now() - startedAtMs;
  log.info(LOG_EVENTS.GENERATE_FIRST_CHUNK, { requestId, providerId: input.providerId, ttftMs });

  const encoder = new TextEncoder();
  let aiText = "";

  async function persistAIParagraph(
    metadata: InventedMetadata | undefined
  ): Promise<"not-applicable" | "written" | "superseded" | "failed"> {
    if (!persistedStoryId) return "not-applicable";
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
        log.warn(LOG_EVENTS.PERSIST_SUPERSEDED, { requestId, storyId: persistedStoryId, position: aiPosition });
        return "superseded";
      }
      return "written";
    } catch (err) {
      // Deliberately swallowed, and scoped to persistence alone. The prose has
      // already streamed to the Writer; turning a mirror-write failure into a
      // stream error would make the client auto-retry and pay for a second
      // generation of a paragraph that already succeeded. Losing the mirror is
      // the smaller loss. Provider failures are NOT swallowed — see pull().
      log.error(LOG_EVENTS.PERSIST_FAILED, { requestId, storyId: persistedStoryId, err });
      return "failed";
    }
  }

  /** done branch shared by start() and pull(): persist, emit the sentinel, close, finish the span. */
  async function completeGeneration(controller: ReadableStreamDefaultController<Uint8Array>, result: GenerationResult) {
    const persistOutcome = await persistAIParagraph(result.invented);
    if (result.invented) {
      controller.enqueue(encoder.encode(METADATA_SENTINEL + JSON.stringify(result.invented)));
    }
    // finish() (span end, logging, the generation_event write) runs before
    // controller.close() rather than after — close() signals "done" to the
    // client immediately, without waiting on pull()'s own returned promise, so
    // anything sequenced after it here would still be in flight once the
    // caller believes the request is fully finished.
    await finish({
      outcome: persistOutcome === "failed" ? "persist_failed" : "success",
      persisted: persistOutcome === "written",
      result,
      ttftMs,
      totalMs: Date.now() - startedAtMs,
    });
    controller.close();
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        if (first.done) {
          await completeGeneration(controller, first.value);
        } else {
          aiText += first.value;
          controller.enqueue(encoder.encode(first.value));
        }
      });
    },
    pull(controller) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            await completeGeneration(controller, value);
          } else {
            aiText += value;
            controller.enqueue(encoder.encode(value));
          }
        } catch (err) {
          await finish({
            outcome: "provider_error",
            persisted: false,
            ttftMs,
            totalMs: Date.now() - startedAtMs,
            err,
          });
          // A provider failure mid-stream has to reach the client. The client maps
          // a broken stream to "stream-aborted" and runs its single auto-retry;
          // closing the stream normally instead would hand the Writer a truncated
          // paragraph presented as a finished one, with nothing to retry from.
          controller.error(err);
        }
      });
    },
    cancel(reason) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        // The Writer's client discards the partial text too (streamGeneration returns
        // without onDone on abort), so dropping it here keeps both sides in sync. The
        // client's one auto-retry re-runs the whole turn; syncStoryParagraphs is
        // idempotent against the already-persisted Writer paragraphs, so the retry
        // appends nothing and simply regenerates the AI turn.
        await finish({
          outcome: "cancelled",
          persisted: false,
          ttftMs,
          totalMs: Date.now() - startedAtMs,
        });
        // The value passed to .return() is never read by anything — its only
        // purpose here is the side effect of running the generator's cleanup
        // (e.g. disposing the underlying SDK stream). The cast reflects that:
        // there is no real GenerationResult to offer on a cancelled turn.
        await iterator.return?.(undefined as unknown as GenerationResult);
        void reason;
      });
    },
  });

  console.log(`[generate:timing] returning Response at +${Date.now() - t0}ms`); // TEMPORARY, see ADR 0021
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
}
