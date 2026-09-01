import { REMOTE_CONTROL_ROUTES, type MockResponse } from "../../test-support/mock-provider/types";
import { MOCK_PROVIDER_URL } from "../constants";

/**
 * Sets the mock provider's script for the current spec, via the remote-control
 * HTTP plane (see test-support/mock-provider/types.ts's MockProviderOptions —
 * the mock server runs in Playwright's root process via global-setup.ts, not in
 * this worker process, so an in-process setScript() call can't reach it).
 *
 * Pass one response for a fixed reply to every generation call this test makes,
 * or several for a sequence (e.g. [truncate, success] for a retry test) — the
 * last entry repeats once the queue is exhausted.
 */
export async function setMockScript(...responses: MockResponse[]): Promise<void> {
  const response = await fetch(`${MOCK_PROVIDER_URL}${REMOTE_CONTROL_ROUTES.queue}`, {
    method: "POST",
    body: JSON.stringify({ responses }),
  });
  if (!response.ok) {
    throw new Error(`setMockScript: mock provider rejected the queue (${response.status})`);
  }
}

/** Clears the queue and the call counter — call between tests that share a spec file. */
export async function resetMockScript(): Promise<void> {
  await fetch(`${MOCK_PROVIDER_URL}${REMOTE_CONTROL_ROUTES.reset}`, { method: "POST" });
}

/** Total requests the mock has handled since the last reset. */
export async function getMockCallCount(): Promise<number> {
  const response = await fetch(`${MOCK_PROVIDER_URL}${REMOTE_CONTROL_ROUTES.calls}`);
  const data = (await response.json()) as { count: number };
  return data.count;
}

/**
 * A well-formed streaming response, optionally inventing a theme/characters —
 * UC-3's "AI invents a theme when none was given" tag.
 *
 * `invented` does NOT fabricate the app's own out-of-band metadata sentinel
 * (that's something src/app/api/generate/route.ts appends automatically,
 * downstream of the real adapter — it is not part of the raw model output).
 * Instead it prepends the raw `THEME:`/`CHARACTERS:`/`---` header format that
 * src/lib/providers/prompt.ts's buildKickoffInstruction asks a real model for
 * on a true zero-input turn, and that extractInventedMetadata parses and
 * strips before route.ts ever sees the text — exercising the real pipeline
 * end to end, same as test-support/mock-provider/server.test.ts's own
 * "zero-input metadata header" case. Only meaningful when the request is
 * actually a zero-input kickoff (empty storySoFar, no theme/characters/
 * openingLines) — extractInventedMetadata ignores this header format
 * otherwise.
 */
export function streamResponse(
  chunks: string[],
  opts?: { delayMs?: number; invented?: { theme?: string; characters?: string } }
): MockResponse {
  const allChunks = opts?.invented
    ? [`THEME: ${opts.invented.theme ?? ""}\nCHARACTERS: ${opts.invented.characters ?? ""}\n---\n`, ...chunks]
    : chunks;
  return { kind: "stream", chunks: allChunks, delayMs: opts?.delayMs };
}

/** Writes some chunks, then destroys the socket mid-stream — the client's
 *  single silent auto-retry is what's supposed to recover from this. */
export function truncateResponse(chunks: string[]): MockResponse {
  return { kind: "truncate", chunks };
}

/** A non-2xx before any chunk — the route maps this to a 502. */
export function errorResponse(status: number, message?: string): MockResponse {
  return { kind: "error", status, body: message ? { message } : undefined };
}

/** Accepted and never answered. */
export function hangResponse(): MockResponse {
  return { kind: "hang" };
}
