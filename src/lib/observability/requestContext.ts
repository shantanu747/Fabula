import { context, createContextKey } from "@opentelemetry/api";

/**
 * Carries per-request state through OTel's context propagation — the same
 * mechanism `route.ts` already uses to keep its span active across
 * `driveGeneration`'s awaits (docs/adr/0022). `withRoute.ts` opens one scope
 * per request; everything nested inside it (`db/tracing.ts`'s Proxy,
 * `generate/route.ts`'s own handler) reads back out of it, without either
 * side needing a function signature threaded three modules deep.
 *
 * Requires a real `ContextManager` to be registered — `@vercel/otel`'s
 * `registerOTel()` does this in every Next.js runtime. A plain Vitest run
 * has none by default and this propagation is then a same-process no-op
 * (verified directly: without a registered `AsyncLocalStorageContextManager`,
 * even *synchronous* nested reads of `context.active()` see the un-scoped
 * root context, not just ones across an await) — a test exercising either
 * value below must register one itself, exactly the requirement ADR 0022
 * already documents for span parent/child assertions.
 */

interface RoundtripCounter {
  count: number;
}

const ROUNDTRIP_COUNTER_KEY = createContextKey("fabula.db.roundtrip_counter");
const REQUEST_ID_KEY = createContextKey("fabula.request_id");

/**
 * Opens one request's scope: a fresh round-trip counter, and the request id
 * `withRoute` already resolved (so a handler reading it back via
 * `getActiveRequestId()` never has to call `resolveRequestId` a second time
 * against the same inbound request and risk minting a *different* id than
 * the one already on the response header and span — see `withRoute.ts`).
 * Returns both `fn`'s result and the counter to read once `fn` (and
 * everything it awaited) has finished.
 */
export function withRequestScope<T>(requestId: string, fn: () => Promise<T>): { result: Promise<T>; counter: { count: number } } {
  const counter: RoundtripCounter = { count: 0 };
  const ctx = context.active().setValue(ROUNDTRIP_COUNTER_KEY, counter).setValue(REQUEST_ID_KEY, requestId);
  const result = context.with(ctx, fn);
  return { result, counter };
}

/** Called by `db/tracing.ts` on every counted statement. A no-op outside any
 *  `withRequestScope` scope — a script or a cron job making a database call
 *  has no request to attribute a round trip to. */
export function incrementActiveRoundtripCounter(): void {
  const counter = context.active().getValue(ROUNDTRIP_COUNTER_KEY) as RoundtripCounter | undefined;
  if (counter) counter.count += 1;
}

/**
 * Reads the active counter's current value without ending its scope — for a
 * route that reports its own `fabula.db.roundtrips` metric instead of
 * trusting `withRoute`'s automatic one (see its `selfReportsRoundtrips`
 * option and `generate/route.ts`'s `finish()`, docs/adr/0049): a streaming
 * response's handler promise resolves before its `ReadableStream` body has
 * made every database call it's going to make, so recording the count at
 * that point would under-report it. Returns 0 outside any counting scope.
 */
export function readActiveRoundtripCount(): number {
  const counter = context.active().getValue(ROUNDTRIP_COUNTER_KEY) as RoundtripCounter | undefined;
  return counter?.count ?? 0;
}

/** The request id `withRoute` already resolved for the request currently
 *  being handled, or `undefined` outside any `withRequestScope` — a handler
 *  that might run standalone (a direct unit-test call, bypassing
 *  `withRoute` entirely) should fall back to its own `resolveRequestId`
 *  call in that case, not treat `undefined` as an error. */
export function getActiveRequestId(): string | undefined {
  return context.active().getValue(REQUEST_ID_KEY) as string | undefined;
}
