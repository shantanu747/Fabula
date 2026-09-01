/**
 * Shared types for the mock provider server. Built for the eval harness
 * (docs/plans/v3/01) and reused by the E2E harness (plan 02) and the
 * timeout/abort work (plan 04) — keep it provider-general.
 */

/** Which vendor wire format the mock should speak. Both chat-completions-style
 *  providers (openai, openrouter) share the "openai" shape. */
export type Vendor = "anthropic" | "openai";

export interface MockRequest {
  vendor: Vendor;
  path: string;
  /** Parsed JSON request body. Headers are deliberately not exposed: nothing
   *  downstream should ever depend on (or accidentally persist) auth headers. */
  body: unknown;
}

export type MockResponse =
  /** A complete, well-formed streaming response. */
  | { kind: "stream"; chunks: string[]; delayMs?: number }
  /** Writes the prologue and some chunks, then destroys the socket mid-stream. */
  | { kind: "truncate"; chunks: string[] }
  /** A non-2xx response; SDKs surface this as an APIError. */
  | { kind: "error"; status: number; body?: unknown }
  /** Accepts the request and never responds; the caller times out or aborts. */
  | { kind: "hang" };

/** The per-request response decider. Swapped between tests via setScript(). */
export type MockScript = (request: MockRequest) => MockResponse;

export interface MockProvider {
  /** Base URL to hand to an SDK, e.g. `http://127.0.0.1:51234`. */
  url: string;
  port: number;
  setScript(script: MockScript): void;
  stop(): Promise<void>;
}

export interface MockProviderOptions {
  /** Defaults to 0 (ephemeral) so parallel suites never collide. */
  port?: number;
  /**
   * Adds an HTTP control plane (POST /__mock/queue, POST /__mock/reset,
   * GET /__mock/calls) for configuring responses from a different process than
   * the one that called startMockProvider() — needed for the E2E harness, where
   * Playwright's global-setup (which starts this server, ahead of the app under
   * test) and the spec files (which need to pick the next response) run in
   * separate processes. Vitest/eval usage is same-process and uses setScript()
   * instead; this defaults off so that path is unaffected.
   */
  remoteControl?: boolean;
}

/** Route paths for the optional remote-control plane. Shared so a remote caller
 *  (e2e/helpers/mock.ts) and the server agree on them without duplicating literals. */
export const REMOTE_CONTROL_ROUTES = {
  queue: "/__mock/queue",
  reset: "/__mock/reset",
  calls: "/__mock/calls",
} as const;
