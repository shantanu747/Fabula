import { eq } from "drizzle-orm";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { auth } from "@/auth";
import { getDb, hasDatabase } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { insertAIParagraph, syncStoryParagraphs } from "@/lib/db/paragraphs";
import { hashStoryParagraphs } from "@/lib/story/contentHash";
import { insertGenerationEvent } from "@/lib/db/generationEvents";
import { guardGenerate } from "@/lib/ratelimit/guard";
import { clientIp } from "@/lib/ratelimit/policy";
import { acquireLease } from "@/lib/admission/lease";
import { checkBudget, recordSpend, type BudgetIdentity } from "@/lib/budget";
import {
  FIRST_CHUNK_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  RESUME_GRACE_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from "@/lib/providers/constants";
import { getProvider, suggestAlternative } from "@/lib/providers/registry";
import { estimateCostUsd } from "@/lib/providers/pricing";
import type { GenerationResult, InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { resolveRequestId } from "@/lib/observability/requestId";
import { encodeHeartbeat, encodeStreamEvent, type StreamEvent } from "@/lib/streaming/protocol";
import { createResumeBuffer } from "@/lib/streaming/resumeBuffer";
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

/** Comment/heartbeat cadence during long provider silence (docs/adr/0042) —
 *  well under STREAM_IDLE_TIMEOUT_MS, so an intermediary never mistakes an
 *  idle-but-alive stream for a dead one. */
const HEARTBEAT_INTERVAL_MS = 15_000;

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
    // Explicit columns, not SELECT * — this route never needs openingLines or
    // the invented jsonb blob just to check ownership (docs/adr/0041).
    // paragraphCount/contentHash are the denormalized values the hash-based
    // fast path in syncStoryParagraphs compares against, fetched here rather
    // than with a second round trip.
    const [story] = await db
      .select({
        id: stories.id,
        ownerId: stories.ownerId,
        paragraphCount: stories.paragraphCount,
        contentHash: stories.contentHash,
      })
      .from(stories)
      .where(eq(stories.id, input.storyId));
    if (!story || story.ownerId !== session.user.id) {
      return withRequestId(Response.json({ error: "Story not found" }, { status: 404 }), requestId);
    }

    const sync = await syncStoryParagraphs(db, story.id, input.storySoFar, {
      paragraphCount: story.paragraphCount,
      contentHash: story.contentHash,
    });
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
            ...(args.result.usage.cacheReadInputTokens !== undefined
              ? { "gen_ai.usage.cache_read_input_tokens": args.result.usage.cacheReadInputTokens }
              : {}),
            ...(args.result.usage.cacheCreationInputTokens !== undefined
              ? { "gen_ai.usage.cache_creation_input_tokens": args.result.usage.cacheCreationInputTokens }
              : {}),
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
        ? {
            inputTokens: args.result.usage.inputTokens,
            outputTokens: args.result.usage.outputTokens,
            ...(args.result.usage.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: args.result.usage.cacheReadInputTokens }
              : {}),
            ...(args.result.usage.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: args.result.usage.cacheCreationInputTokens }
              : {}),
          }
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
        cacheReadInputTokens: args.result?.usage?.cacheReadInputTokens,
        cacheCreationInputTokens: args.result?.usage?.cacheCreationInputTokens,
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

  // --- Timeouts and cancellation (docs/adr/0023, extended by docs/adr/0043) --
  //
  // One AbortController drives the provider call throughout its life. Three
  // independent sources can trip it: the client going away (request.signal —
  // wired in here so an abandoned tab stops costing money both before and
  // during streaming), our own idle timers, and — once streaming has begun
  // and Redis is configured — a one-shot grace timer that gives a disconnected
  // client a bounded window to be resumed before its provider call is finally
  // killed (docs/adr/0043). `abortReason` is tracked explicitly rather than
  // inferred from the resulting error's name/type, because that can't tell a
  // client disconnect apart from our own timeout — both surface as an
  // AbortError from the SDK.
  const providerAbort = new AbortController();
  let abortReason: "client" | "timeout" | undefined;
  // Declared here, not only where first used, so armTimeout's heartbeat branch
  // below never risks a temporal-dead-zone reference — it's called once
  // pre-first-chunk (no controller, heartbeat branch never taken) before this
  // point would otherwise be reached if it were declared later.
  const encoder = new TextEncoder();

  // Resume state, referenced by closures defined before it's known whether
  // the request will ever reach the streaming phase at all (a pre-first-chunk
  // disconnect must still abort immediately — the client has no requestId to
  // resume with yet, since headers haven't been sent).
  let streamStarted = false;
  let clientGone = false;
  let disconnectHandled = false;
  // `resumeBuffer` itself is declared further down, as a `const`, right where
  // it's actually assigned (once, unconditionally) — every closure defined
  // here that reads it (handleDisconnect, emit, driveGeneration) is only ever
  // invoked after that assignment has run, so referencing it ahead of its own
  // declaration is safe: a closure resolves free variables at call time, not
  // definition time.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  function clearGraceTimer() {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  }

  /** The one place a client disconnect is actually handled, reached from both
   *  `request.signal`'s abort listener and the ReadableStream's own `cancel()`
   *  — a real disconnect can trip either first, or both. Idempotent, so which
   *  one gets there first doesn't matter. */
  function handleDisconnect() {
    if (disconnectHandled) return;
    disconnectHandled = true;
    clientGone = true;

    if (streamStarted && resumeBuffer) {
      // Keep the provider call running, unresumed, for one bounded window —
      // the substance of the resume tradeoff (docs/adr/0043). The still-running
      // generation loop (driveGeneration) is what actually observes this abort
      // and reaches a terminal state; this function only ever schedules it.
      graceTimer = setTimeout(() => {
        abortReason = "client";
        providerAbort.abort();
      }, RESUME_GRACE_MS);
    } else {
      // No resume possible (pre-stream, or Redis unavailable) — abort now,
      // exactly the pre-existing behavior.
      abortReason = "client";
      providerAbort.abort();
    }
  }

  function onClientAbort() {
    handleDisconnect();
  }
  request.signal.addEventListener("abort", onClientAbort);
  if (request.signal.aborted) onClientAbort();

  // `AbortSignal.timeout()` can't be rearmed, and the idle phase needs exactly
  // that (reset on every chunk) — a plain timer paired with a shared
  // AbortController is what actually supports both phases (a fixed budget pre-
  // first-chunk, a resettable one once streaming starts) off one signal.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** `controller` is only ever passed once streaming has actually begun — a
   *  heartbeat before then would write bytes into a response that doesn't
   *  exist yet. */
  function armTimeout(ms: number, controller?: ReadableStreamDefaultController<Uint8Array>) {
    idleTimer = setTimeout(() => {
      abortReason = "timeout";
      providerAbort.abort();
    }, ms);
    if (controller) {
      heartbeatTimer = setInterval(() => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(encodeHeartbeat()));
        } catch {
          clientGone = true;
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
  }
  function clearIdle() {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
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

  let aiText = "";
  let eventIdCounter = 0;
  function nextEventId(): number {
    return ++eventIdCounter;
  }

  // Guards the stream lifecycle against running its terminal logic twice: a
  // client disconnect mid-stream can reach `driveGeneration`'s catch (via the
  // request.signal listener above, forwarded onto providerAbort) and the
  // platform's own ReadableStream `cancel()` at nearly the same time, since
  // both ultimately observe the same disconnect.
  let finishedOnce = false;
  async function finishOnce(args: FinishArgs): Promise<boolean> {
    if (finishedOnce) return false;
    finishedOnce = true;
    clearGraceTimer();
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
      // input.storySoFar is exactly what's already stored through aiPosition-1
      // (syncStoryParagraphs above proved that) — the resulting content once
      // this AI paragraph lands is that plus this one paragraph, so its hash
      // is computed the same way as any other successful append (docs/adr/0041).
      const newContentHash = await hashStoryParagraphs([
        ...input.storySoFar,
        { author: "ai" as const, text: aiText, providerId: input.providerId },
      ]);
      const wrote = await insertAIParagraph(db, {
        storyId: persistedStoryId,
        text: aiText,
        providerId: input.providerId,
        position: aiPosition,
        newParagraphCount: aiPosition + 1,
        newContentHash,
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

  /**
   * Writes one frame. Silently skips the live write once the client is known
   * gone (a torn-down controller throws on enqueue) but always records into
   * the resume buffer when one exists — that's the entire mechanism that lets
   * a reconnecting client catch up, including the tail of a generation that
   * finished after its original connection dropped (docs/adr/0043).
   */
  async function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent): Promise<void> {
    const id = nextEventId();
    if (!clientGone) {
      try {
        controller.enqueue(encoder.encode(encodeStreamEvent(id, event)));
      } catch {
        // The consumer vanished between our clientGone check and this call —
        // treat it as already-gone rather than let this throw mask whatever
        // the caller is in the middle of reporting.
        clientGone = true;
      }
    }
    if (resumeBuffer) await resumeBuffer.record(id, event);
  }

  /** done branch shared by every path through driveGeneration below: persist,
   *  emit meta/usage/done, close, finish the span. Runs — and persists —
   *  exactly the same way whether or not the client is still connected, since
   *  a completion reached during the resume grace window is a real success
   *  the Writer just hasn't seen yet. */
  async function handleGenerationResult(controller: ReadableStreamDefaultController<Uint8Array>, result: GenerationResult) {
    const persistOutcome = await persistAIParagraph(result.invented);

    await emit(controller, { event: "meta", data: { invented: result.invented } });
    await emit(controller, {
      event: "usage",
      data: {
        model: result.model,
        ...(result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              ...(result.usage.cacheCreationInputTokens !== undefined
                ? { cacheCreationInputTokens: result.usage.cacheCreationInputTokens }
                : {}),
              ...(result.usage.cacheReadInputTokens !== undefined
                ? { cacheReadInputTokens: result.usage.cacheReadInputTokens }
                : {}),
            }
          : {}),
      },
    });
    await emit(controller, {
      event: "done",
      data: {
        persisted: persistOutcome === "written",
        ...(persistedStoryId ? { position: aiPosition, storyId: persistedStoryId } : {}),
      },
    });

    // finish() (span end, logging, the generation_event write) runs before
    // controller.close() rather than after — close() signals "done" to the
    // client immediately, without waiting on this function's own returned
    // promise, so anything sequenced after it here would still be in flight
    // once the caller believes the request is fully finished.
    const didFinish = await finishOnce({
      outcome: persistOutcome === "failed" ? "persist_failed" : "success",
      persisted: persistOutcome === "written",
      result,
      ttftMs,
      totalMs: Date.now() - startedAtMs,
    });
    if (didFinish) {
      if (resumeBuffer) await resumeBuffer.flush();
      if (!clientGone) {
        try {
          controller.close();
        } catch {
          // Already gone — nothing to close.
        }
      }
    }
  }

  /** The generation-driving loop, run once from `start()` and never gated by
   *  `pull()` — a client disconnect must not stop this from progressing
   *  toward a terminal state during the resume grace window, and `pull()`'s
   *  backpressure has nothing real to protect here (the provider keeps
   *  generating regardless of how fast the browser reads). */
  async function driveGeneration(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (first.done) {
      await handleGenerationResult(controller, first.value);
      return;
    }
    aiText += first.value;
    await emit(controller, { event: "chunk", data: { text: first.value } });
    armTimeout(STREAM_IDLE_TIMEOUT_MS, controller);

    for (;;) {
      let step: IteratorResult<string, GenerationResult>;
      try {
        step = await iterator.next();
      } catch (err) {
        clearIdle();

        if (clientGone) {
          // Either the grace window expired (resumeBuffer set) or resume was
          // never possible (Redis unavailable) — either way there is no live
          // consumer, so record a terminal frame into the resume buffer only
          // (if one exists), so a reconnecting client gets a clean typed
          // error instead of hanging forever waiting for a generation that
          // will never finish.
          if (resumeBuffer) {
            const id = nextEventId();
            await resumeBuffer.record(id, {
              event: "error",
              data: {
                kind: "stream-aborted",
                message: "Generation was cancelled after the connection stayed away too long to resume.",
                retryable: true,
              },
            });
          }
          const didFinish = await finishOnce({
            outcome: "cancelled",
            persisted: false,
            ttftMs,
            totalMs: Date.now() - startedAtMs,
          });
          if (didFinish) await safeReturn();
          return;
        }

        // A provider failure or idle stall, client still (as far as we know)
        // connected. The framed protocol's whole point: a typed error frame
        // on a normally-terminated stream, not an abnormal `controller.error()`
        // the client has to infer meaning from. Never offered as a provider
        // switch (docs/adr/0023 rule 3): a seam mid-paragraph is worse than a
        // plain retry, so no suggestedProviderId here, ever.
        await emit(controller, {
          event: "error",
          data: {
            kind: "stream-aborted",
            message: "Generation was interrupted before finishing.",
            retryable: true,
          },
        });
        const didFinish = await finishOnce({
          outcome: "provider_error",
          persisted: false,
          ttftMs,
          totalMs: Date.now() - startedAtMs,
          err,
        });
        if (didFinish) {
          if (resumeBuffer) await resumeBuffer.flush();
          if (!clientGone) {
            try {
              controller.close();
            } catch {
              // Already gone — nothing to close.
            }
          }
        }
        return;
      }

      clearIdle();
      if (step.done) {
        await handleGenerationResult(controller, step.value);
        return;
      }
      aiText += step.value;
      await emit(controller, { event: "chunk", data: { text: step.value } });
      armTimeout(STREAM_IDLE_TIMEOUT_MS, controller);
    }
  }

  // Assigned before streamStarted flips true, deliberately: handleDisconnect's
  // `streamStarted && resumeBuffer` check above short-circuits on
  // `streamStarted` first, so as long as that only ever becomes true once
  // this line has already run, nothing can observe `resumeBuffer` before it
  // exists — safe against `const`'s TDZ even though handleDisconnect
  // references it ahead of this declaration in the source.
  const resumeBuffer = await createResumeBuffer(requestId, admissionIdentity);
  streamStarted = true;

  // driveGeneration's own promise, captured so cancel() below can await it —
  // but only when there's no grace window to wait out (see cancel()).
  let generationDone: Promise<void> = Promise.resolve();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      generationDone = context.with(trace.setSpan(context.active(), span), () => driveGeneration(controller));
      return generationDone;
    },
    cancel(reason) {
      return context.with(trace.setSpan(context.active(), span), async () => {
        handleDisconnect();
        void reason;
        // No resume available: the pre-existing behavior is that a disconnect
        // aborts and cleans up (finishOnce, safeReturn) essentially
        // immediately, and callers of reader.cancel() — including every
        // existing disconnect test — depend on that having already happened
        // by the time this promise resolves. Awaiting driveGeneration's own
        // promise here (rather than doing the cleanup inline, as the old
        // cancel() did) gets the same effect through the one place that now
        // owns it.
        //
        // Resume available: a grace window was just scheduled instead of an
        // immediate abort, and driveGeneration keeps running — for up to
        // RESUME_GRACE_MS — entirely independently of this Response having
        // been considered closed. cancel() must not block on that; the whole
        // point of the grace window is that work continues after the
        // response is closed (docs/adr/0043).
        if (!resumeBuffer) {
          await generationDone;
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
}
