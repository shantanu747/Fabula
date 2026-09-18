import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AppDatabase } from "./types";
import { incrementActiveRoundtripCounter } from "@/lib/observability/requestContext";

/**
 * A `Proxy` over `AppDatabase` emitting one child span per statement
 * (docs/adr/0049). The third use of this interception technique in this
 * codebase — `src/test/latch.ts` (ADR 0014's deterministic race tests) and
 * `bench/roundtrips.ts` (Plan 1's round-trip counter, ADR 0034) are the
 * other two. This module wraps `bench/roundtrips.ts`'s own output rather
 * than re-implementing the same four-method interception a third time —
 * `db/client.ts` composes `wrapWithTracing(roundtripCounter.wrap(raw))`, two
 * Proxies nested around the same target. That's safe specifically because
 * `RoundtripCounter.wrap()` forwards every counted call through unchanged
 * (same arguments, same return value, same thrown errors — see its own doc
 * comment), so nesting another Proxy with the same guarantee around it
 * changes nothing about what either wrapper observes.
 *
 * **What this deliberately does not do, and why.** Drizzle's `select`/
 * `insert`/`update` return a lazy, chainable `QueryPromise` — calling
 * `.then()` on one *executes the statement*, and it is not safe to call more
 * than once (Drizzle's own `.then()` re-runs `this.execute()` on every
 * invocation; it does not memoize). A wrapper that attached its own
 * `.then()` observer to time the statement's actual resolution — the more
 * "accurate" design — would risk a second, independent execution of
 * whatever `insert`/`update` statement it wrapped, which is a correctness
 * bug (a duplicate write), not a rounding error, and the one thing this
 * module must never risk for an accuracy gain. So each span here starts and
 * ends synchronously at the call itself: it does not enclose the network
 * round trip's own duration, only marks that the statement was issued, in
 * order, with its shape, correctly nested under the request's span. Overall
 * request latency remains visible on the parent `http.route` span, and the
 * round-trip *count* — the number this whole plan is really trying to make
 * visible — is exact either way, recorded via `requestContext.ts`.
 *
 * **Never a bound value.** `db.statement` is built from nothing but the
 * method name and, for `select`, the literal column-alias strings the
 * calling code wrote in source — never an argument's runtime contents. This
 * is structural, not a review convention: the four wrapped methods
 * (`select`/`insert`/`update`/`execute`) are only ever intercepted at their
 * *top-level* call, before a caller chains `.from()`/`.where()`/`.values()`
 * onto the return value — so the bound values a query eventually carries
 * (story prose included) are never passed as an argument to this Proxy's
 * trap in the first place. `execute()`'s raw-SQL argument is the one
 * exception worth naming explicitly: Drizzle's `sql` template embeds
 * interpolated values inside the `SQL` object itself (parameterized only at
 * the wire level), so `describeStatement` never inspects it — `execute`
 * always gets the fixed label `"execute(...)"`. See tracing.test.ts's
 * assertion that a known paragraph string cannot appear in any attribute.
 */

const COUNTED_METHODS = ["select", "insert", "update", "execute"] as const;
type CountedMethod = (typeof COUNTED_METHODS)[number];

function isCountedMethod(prop: string | symbol): prop is CountedMethod {
  return typeof prop === "string" && (COUNTED_METHODS as readonly string[]).includes(prop);
}

const tracer = trace.getTracer("fabula");

function describeStatement(method: CountedMethod, args: unknown[]): string {
  if (method === "select") {
    const [columns] = args;
    if (columns && typeof columns === "object") {
      const keys = Object.keys(columns as object);
      if (keys.length > 0) return `select(${keys.join(", ")})`;
    }
    return "select(*)";
  }
  return `${method}(...)`;
}

export function wrapWithTracing(db: AppDatabase): AppDatabase {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!isCountedMethod(prop) || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        incrementActiveRoundtripCounter();
        const span = tracer.startSpan(`db.${prop}`, {
          attributes: {
            "db.system": "postgresql",
            "db.statement": describeStatement(prop, args),
          },
        });
        try {
          return value.apply(target, args);
        } catch (err) {
          span.recordException(err instanceof Error ? err : String(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      };
    },
  });
}
