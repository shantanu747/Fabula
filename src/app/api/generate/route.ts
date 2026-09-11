import { eq } from "drizzle-orm";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { auth } from "@/auth";
import { getDb, hasDatabase } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { insertAIParagraph, syncStoryParagraphs } from "@/lib/db/paragraphs";
import { insertGenerationEvent } from "@/lib/db/generationEvents";
import { guardGenerate } from "@/lib/ratelimit/guard";
import { clientIp } from "@/lib/ratelimit/policy";
import { acquireLease } from "@/lib/admission/lease";
import { checkBudget, recordSpend, type BudgetIdentity } from "@/lib/budget";
import { FIRST_CHUNK_TIMEOUT_MS, MAX_OUTPUT_TOKENS, STREAM_IDLE_TIMEOUT_MS } from "@/lib/providers/constants";
import { getProvider, suggestAlternative } from "@/lib/providers/registry";
import { estimateCostUsd } from "@/lib/providers/pricing";
import type { GenerationResult, InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { resolveRequestId } from "@/lib/observability/requestId";
import {
  isStoryParagraphArray,
  areValidHints,
  isValidTargetLength
} from "@/lib/story/validation";

// "nodejs" is already this route's default at runtime (node_modules/next/dist/docs's
// runtime.md — Edge is deprecated), so this is declarative rather than a behavior
// change; stated explicitly because a deployment platform reads maxDuration from the
// build output per route, and that reading requires the segment config to exist at
// all. 60s exceeds FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS (50s) per
// docs/plans/v4/02-admission-control.md's stated requirement — NOTE, flagged rather
// than silently "fixed": that sum does not include the one same-provider retry
// attemptFirstChunk can take on a fast (non-timeout) failure, which can push a
// legitimate pre-first-chunk retry-then-succeed sequence past 60s and into the
// platform killing the function before the route's own timeout logic would have.
// Raising this to comfortably exceed FIRST_CHUNK_TIMEOUT_MS*2 + STREAM_IDLE_TIMEOUT_MS
// (~70s) is the fix if this is confirmed as a real gap rather than the plan's
// deliberate, tighter number.
export const runtime = "nodejs";
export const maxDuration = 60;

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

  // Last gate before anything costs money. Deliberately after validation and the
  // turn check — a malformed or out-of-turn request never reaches a provider, so
  // spending a token on it would only punish a buggy client.
  const limited = await guardGenerate(request, session?.user?.id);
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

  // Admission control, then spend governance — cheapest rejection first, and
  // both after the rate limit above but before the provider call
  // (docs/plans/v4/02-admission-control.md). Deliberately placed here, after
  // persistence resolves rather than immediately after the rate-limit check:
  // from this point on, every remaining exit path funnels through finish()
  // below, which is where the lease is released and the spend is recorded —
  // one shared teardown for both resources rather than a second lifetime
  // mechanism (docs/adr/0036). A 401/404/409 above never acquired a lease and
  // has nothing to release.
  const budgetIdentity: BudgetIdentity = session?.user?.id
    ? { type: "user", userId: session.user.id }
    : { type: "guest" };
  const admissionIdentity = session?.user?.id ? `user:${session.user.id}` : `guest:${clientIp(request)}`;

  const lease = await acquireLease(admissionIdentity);
  if (!lease.acquired) {
    log.warn(LOG_EVENTS.ADMISSION_REJECTED, { requestId, providerId: input.providerId, authenticated });
    return withRequestId(
      Response.json(
        {
          error: "You already have a story generating. Wait for it to finish before starting another.",
          kind: "at-capacity",
        },
        { status: 429, headers: { "Retry-After": String(lease.retryAfterSeconds) } }
      ),
      requestId
    );
  }
  // Narrowed to a plain reference here rather than read off `lease` inside
  // finish() below: `lease`'s own type is still the acquire/refuse union at
  // that closure's definition site, and TypeScript does not carry the early
  // return's narrowing into a nested function capturing the outer variable.
  const releaseLease = lease.release;

  // hasDatabase() guarded the same way as guardGenerate's own Postgres call:
  // guest writing has never required a database (docs/adr/0009), and spend
  // governance must not quietly turn Postgres into a hard requirement either.
  if (hasDatabase()) {
    const budget = await checkBudget(getDb(), budgetIdentity);
    if (!budget.allowed) {
      await releaseLease();
      log.warn(LOG_EVENTS.BUDGET_REJECTED, { requestId, providerId: input.providerId, authenticated });
      return withRequestId(
        Response.json(
          { error: "Fabula has hit today's limit — try again tomorrow.", kind: "budget-exceeded" },
          { status: 429 }
        ),
        requestId
      );
    }
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

    // The lease's one release call, reached from every terminal outcome finish()
    // itself is reached from (docs/plans/v4/02-admission-control.md) — not a
    // second lifetime mechanism alongside finishedOnce, the same one. Idempotent,
    // so this being called from more than one of finish()'s own call sites is not
    // a concern (it never is, since finish() itself only ever runs once per
    // request either way).
    await releaseLease();
    // Only a completed provider call has anything to bill — a pre-first-chunk or
    // mid-stream failure (no `result`/`usage` at all) never reached the provider
    // in a way that cost money in the first place, and must not count against the
    // budget alongside a real generation. `persist_failed` still bills: the
    // provider was called and paid for even though our own mirror write failed.
    if (args.result?.usage) {
      await recordSpend(budgetIdentity, costUsd);
    }

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

  // Re-bound so its non-undefined type survives into the nested closures below
  // (attemptFirstChunk) — TypeScript doesn't carry the `if (!provider) return`
  // narrowing above across a function boundary, only within the same scope.
  const activeProvider = provider;

  // --- Timeouts and cancellation (docs/adr/0023) -----------------------------
  //
  // One AbortController drives the provider call throughout its life. Two
  // independent sources can trip it: the client going away (request.signal —
  // wired in here for the first time so an abandoned tab stops costing money
  // both before and during streaming) and our own idle timers. `abortReason`
  // is tracked explicitly rather than inferred from the resulting error's
  // name/type, because that can't tell a client disconnect apart from our own
  // timeout — both surface as an AbortError from the SDK.
  const providerAbort = new AbortController();
  let abortReason: "client" | "timeout" | undefined;

  function onClientAbort() {
    abortReason = "client";
    providerAbort.abort();
  }
  request.signal.addEventListener("abort", onClientAbort);
  if (request.signal.aborted) onClientAbort();

  // `AbortSignal.timeout()` can't be rearmed, and the idle phase needs exactly
  // that (reset on every chunk) — a plain timer paired with a shared
  // AbortController is what actually supports both phases (a fixed budget pre-
  // first-chunk, a resettable one once streaming starts) off one signal.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function armTimeout(ms: number) {
    idleTimer = setTimeout(() => {
      abortReason = "timeout";
      providerAbort.abort();
    }, ms);
  }
  function clearIdle() {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  async function attemptFirstChunk(): Promise<
    | { ok: true; iterator: AsyncGenerator<string, GenerationResult, unknown>; first: IteratorResult<string, GenerationResult> }
    | { ok: false; err: unknown }
  > {
    const iterator = activeProvider.generateParagraph({
      storySoFar: input.storySoFar,
      theme: input.theme,
      characters: input.characters,
      openingLines: input.openingLines,
      targetLength: input.targetLength,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: providerAbort.signal,
    });
    armTimeout(FIRST_CHUNK_TIMEOUT_MS);
    try {
      // Pre-fetch the first chunk before committing to a streaming Response, so a bad
      // API key / invalid model / provider error surfaces as a clean 502 instead of a
      // broken 200 stream.
      const first = await iterator.next();
      clearIdle();
      return { ok: true, iterator, first };
    } catch (err) {
      clearIdle();
      return { ok: false, err };
    }
  }

  let attempt = await attemptFirstChunk();

  // Rule: a fast failure (a real error, not our own timeout, and not the
  // client leaving) gets exactly one retry against the same provider before
  // giving up — a fresh generator each time, never re-driving a finished one.
  // A timeout never retries: it already cost the Writer the full budget once,
  // and doubling that wait before they learn anything is worse than asking.
  if (!attempt.ok && abortReason === undefined) {
    attempt = await attemptFirstChunk();
  }

  if (!attempt.ok) {
    if (abortReason === "client") {
      // The client is already gone — nothing reads this response, and it must
      // not read as a provider failure in the cost/outcome history.
      await finish({ outcome: "cancelled", persisted: false, totalMs: Date.now() - startedAtMs });
      return withRequestId(new Response(null, { status: 499 }), requestId);
    }

    await finish({
      outcome: "provider_error",
      persisted: false,
      totalMs: Date.now() - startedAtMs,
      err: attempt.err,
    });

    // Same posture as ADR 0011's uninformative registration responses: never
    // tell the client whether this was a bad key, a provider outage, or a
    // timeout — only that the provider isn't responding. The real cause is in
    // the server-side log line above.
    const suggestedId = suggestAlternative(activeProvider.id);
    const suggestedProvider = suggestedId ? getProvider(suggestedId) : undefined;
    return withRequestId(
      Response.json(
        {
          error: `${activeProvider.displayName} isn't responding right now.`,
          kind: "provider-unavailable",
          failedProviderId: activeProvider.id,
          ...(suggestedProvider
            ? { suggestedProviderId: suggestedProvider.id, suggestedProviderName: suggestedProvider.displayName }
            : {}),
        },
        { status: 502 }
      ),
      requestId
    );
  }

  const { iterator, first } = attempt;
  const ttftMs = Date.now() - startedAtMs;
  log.info(LOG_EVENTS.GENERATE_FIRST_CHUNK, { requestId, providerId: input.providerId, ttftMs });

  const encoder = new TextEncoder();
  let aiText = "";

  // Guards the stream lifecycle against running its terminal logic twice: a
  // client disconnect mid-stream can reach `pull()`'s catch (via the
  // request.signal listener above, forwarded onto providerAbort) and the
  // platform's own ReadableStream `cancel()` at nearly the same time, since
  // both ultimately observe the same disconnect.
  let finishedOnce = false;
  async function finishOnce(args: FinishArgs): Promise<boolean> {
    if (finishedOnce) return false;
    finishedOnce = true;
    await finish(args);
    return true;
  }

  async function safeReturn() {
    try {
      // The value passed to .return() is never read by anything — its only
      // purpose here is the side effect of running the generator's cleanup
      // (e.g. disposing the underlying SDK stream). The cast reflects that:
      // there is no real GenerationResult to offer on a cancelled turn.
      await iterator.return?.(undefined as unknown as GenerationResult);
    } catch {
      // Idempotent-safe: the SDK may already be tearing down from the abort
      // signal firing, and a throw here must not mask the real outcome.
    }
  }

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
    const didFinish = await finishOnce({
      outcome: persistOutcome === "failed" ? "persist_failed" : "success",
      persisted: persistOutcome === "written",
      result,
      ttftMs,
      totalMs: Date.now() - startedAtMs,
    });
    if (didFinish) controller.close();
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        if (first.done) {
          await completeGeneration(controller, first.value);
        } else {
          aiText += first.value;
          controller.enqueue(encoder.encode(first.value));
          armTimeout(STREAM_IDLE_TIMEOUT_MS);
        }
      });
    },
    pull(controller) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const { value, done } = await iterator.next();
          clearIdle();
          if (done) {
            await completeGeneration(controller, value);
          } else {
            aiText += value;
            controller.enqueue(encoder.encode(value));
            armTimeout(STREAM_IDLE_TIMEOUT_MS);
          }
        } catch (err) {
          clearIdle();
          if (abortReason === "client") {
            // The platform's own cancel() below is what actually runs cleanup
            // for a disconnected client; touching a controller whose consumer
            // is already gone risks throwing on top of the original error.
            return;
          }
          // A provider failure or stall mid-stream has to reach the client. The
          // client maps a broken stream to "stream-aborted" and runs its single
          // auto-retry; closing the stream normally instead would hand the
          // Writer a truncated paragraph presented as a finished one, with
          // nothing to retry from. Never offered as a provider switch (see
          // docs/adr/0023): a seam mid-paragraph is worse than a plain retry.
          const didFinish = await finishOnce({
            outcome: "provider_error",
            persisted: false,
            ttftMs,
            totalMs: Date.now() - startedAtMs,
            err,
          });
          if (didFinish) controller.error(err);
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
        clearIdle();
        await finishOnce({
          outcome: "cancelled",
          persisted: false,
          ttftMs,
          totalMs: Date.now() - startedAtMs,
        });
        await safeReturn();
        void reason;
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
}
