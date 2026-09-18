import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

/**
 * Registers the same `ContextManager` `@vercel/otel`'s `registerOTel()`
 * registers in every real Next.js runtime — Vitest never calls that, so
 * without this, `context.with()` is a no-op (verified directly: even a
 * *synchronous* nested `context.active()` read sees the un-scoped root
 * context, not just one across an await — ADR 0022 already documented the
 * across-await half of this for span parent/child correlation).
 *
 * Needed by any test exercising `withRoute.ts`, `db/tracing.ts`, or
 * `requestContext.ts` — a wrapped route handler relies on `context.with`
 * to make its span the active parent for a nested `fabula.generate` span
 * and to propagate its round-trip counter down to `db/tracing.ts`'s Proxy.
 * Safe to register globally: it only makes *explicit* `context.with(...)`
 * scoping actually work, it does not fabricate an active span or context
 * value where nothing set one (`logger.test.ts`'s "omits traceId/spanId
 * when no span is active" stays true regardless).
 */
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
