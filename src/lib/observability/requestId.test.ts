import { describe, expect, it } from "vitest";
import { resolveRequestId } from "./requestId";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/generate", { method: "POST", headers });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveRequestId", () => {
  it("preserves a valid inbound x-request-id", () => {
    expect(resolveRequestId(requestWith({ "x-request-id": "client-abc-123" }))).toBe(
      "client-abc-123"
    );
  });

  it("mints a UUID when no header is present", () => {
    expect(resolveRequestId(requestWith({}))).toMatch(UUID_RE);
  });

  it("mints a UUID for an empty header", () => {
    expect(resolveRequestId(requestWith({ "x-request-id": "" }))).toMatch(UUID_RE);
  });

  it("mints a UUID for an over-long header — a validated request id, not an unbounded one", () => {
    const tooLong = "a".repeat(129);
    expect(resolveRequestId(requestWith({ "x-request-id": tooLong }))).toMatch(UUID_RE);
  });

  it("accepts exactly the length boundary", () => {
    const exactly128 = "a".repeat(128);
    expect(resolveRequestId(requestWith({ "x-request-id": exactly128 }))).toBe(exactly128);
  });

  it.each([
    ["a space", "has space"],
    ["a newline-shaped value", "line1\nline2"],
    ["a header-injection attempt", "id\r\nX-Injected: evil"],
    ["non-ASCII", "id-éé"],
  ])("mints a UUID rather than echoing back %s", (_label, value) => {
    // Not exercised via the Request/Headers layer for the newline/CR cases —
    // the Fetch API's Headers itself normalises or rejects those before this
    // function ever sees them — so this drives resolveRequestId's validation
    // directly to prove it doesn't rely on that upstream behaviour.
    const fakeRequest = {
      headers: { get: () => value },
    } as unknown as Request;

    expect(resolveRequestId(fakeRequest)).toMatch(UUID_RE);
  });
});
