import { trace } from "@opentelemetry/api";

/**
 * Dotted, stable event names as a const object so a call site can't drift by
 * typo — every log call names one of these, never a free-text string.
 */
export const LOG_EVENTS = {
  GENERATE_STARTED: "generate.started",
  GENERATE_FIRST_CHUNK: "generate.first_chunk",
  GENERATE_COMPLETED: "generate.completed",
  GENERATE_FAILED: "generate.failed",
  GENERATE_CANCELLED: "generate.cancelled",
  PERSIST_SUPERSEDED: "persist.superseded",
  PERSIST_FAILED: "persist.failed",
  RATELIMIT_REJECTED: "ratelimit.rejected",
  REGISTER_REJECTED: "register.rejected",
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

type LogLevel = "info" | "warn" | "error";

/**
 * A redaction ALLOWLIST, not a denylist. Only these field names may reach a log
 * line; anything else is dropped (with a `logger.unknown_field` warning) rather
 * than passed through. This is what makes it structurally impossible for a log
 * call to leak a story paragraph, a prompt, an email address, or a raw IP — see
 * logger.test.ts.
 */
const ALLOWED_FIELDS = new Set([
  "requestId",
  "providerId",
  "storyId",
  "authenticated",
  "outcome",
  "reason",
  "position",
  "model",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "ttftMs",
  "totalMs",
  "policy",
  "retryAfterSeconds",
  "err",
]);

export type LogFields = Record<string, unknown>;

/** Never the raw Error object (its message could, in principle, embed request
 *  data from a provider SDK) — just the two fields worth having in a log line. */
function serializeError(err: unknown): { name: string; message: string } | string {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return String(err);
}

function unknownField(field: string): void {
  // Deliberately not routed through emit() below — this warns about the logger
  // itself, not about application state, and must never recurse.
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "logger.unknown_field",
      field,
    })
  );
}

function emit(level: LogLevel, event: LogEvent, fields: LogFields): void {
  const spanContext = trace.getActiveSpan()?.spanContext();

  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      unknownField(key);
      continue;
    }
    clean[key] = key === "err" ? serializeError(value) : value;
  }

  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    // Omitted entirely when no span is active — never fabricated.
    ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
    ...clean,
  };

  // JSON.stringify escapes any newline inside a field value, so one JSON object
  // always maps to exactly one output line regardless of field content.
  console.log(JSON.stringify(line));
}

export const log = {
  info: (event: LogEvent, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: LogEvent, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: LogEvent, fields: LogFields = {}) => emit("error", event, fields),
};
