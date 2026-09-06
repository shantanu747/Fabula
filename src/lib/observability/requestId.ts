const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Honours an inbound `x-request-id` only when its shape is safe to echo back
 * into logs and response headers verbatim — an unvalidated header is a
 * log-injection vector (control characters, oversized values, anything outside
 * a conservative character set). Anything that fails the check is silently
 * replaced with a fresh UUID rather than rejected with an error: a malformed
 * request id from a client shouldn't fail the request, it just doesn't get to
 * choose its own correlation id.
 */
export function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && VALID_REQUEST_ID.test(header)) return header;
  return crypto.randomUUID();
}
