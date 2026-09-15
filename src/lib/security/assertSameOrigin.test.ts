import { describe, expect, it } from "vitest";
import { assertSameOrigin } from "./assertSameOrigin";

function request(origin: string | undefined): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.Origin = origin;
  return new Request("http://localhost/api/stories", { method: "POST", headers });
}

describe("assertSameOrigin", () => {
  it("passes a same-origin request through", () => {
    expect(assertSameOrigin(request("http://localhost"))).toBeNull();
  });

  it("rejects a cross-origin request", async () => {
    const response = assertSameOrigin(request("https://evil.example"));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("rejects a request with no Origin header at all", () => {
    const response = assertSameOrigin(request(undefined));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("treats a same-scheme-and-host-but-different-port origin as cross-origin", () => {
    // Origins differ on port too — "same origin" is scheme+host+port together.
    const response = assertSameOrigin(request("http://localhost:9999"));
    expect(response!.status).toBe(403);
  });
});
