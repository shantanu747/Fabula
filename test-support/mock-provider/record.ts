/**
 * Records a real provider's raw SSE body while the real SDK still drives the
 * request. Both Stainless-generated SDKs accept a `fetch` constructor option
 * (verified in node_modules/@anthropic-ai/sdk/client.d.ts and the openai
 * equivalent), which lets us reuse the SDK's exact request build — headers
 * and JSON body — instead of hand-rolling it, and just keep a copy of what
 * comes back.
 *
 * Only the response body is captured. Request headers never leave the
 * process, so no API key can end up in a committed fixture.
 */

export interface TapedResponse {
  status: number;
  body: string;
}

export interface TapingFetch {
  fetchFn: typeof globalThis.fetch;
  readonly responses: TapedResponse[];
  /** The most recent response body — for single-request flows this is the fixture's rawSse. */
  lastBody(): string;
}

export function createTapingFetch(): TapingFetch {
  const responses: TapedResponse[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    responses.push({ status: response.status, body: text });
    // Re-wrap: the SDK still needs a readable body to stream from.
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetchFn,
    responses,
    lastBody() {
      const last = responses[responses.length - 1];
      if (!last) throw new Error("taping fetch: no response recorded");
      return last.body;
    },
  };
}
