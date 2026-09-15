import { describe, expect, it } from "vitest";
import { readJsonBody, DEFAULT_MAX_BODY_BYTES } from "./readJsonBody";

function request(body: string): Request {
  return new Request("http://localhost/api/stories", { method: "POST", body });
}

describe("readJsonBody", () => {
  it("parses a well-formed, in-bounds body", async () => {
    const result = await readJsonBody(request(JSON.stringify({ a: 1 })));
    expect(result).toEqual({ ok: true, body: { a: 1 } });
  });

  it("rejects invalid JSON with a 400", async () => {
    const result = await readJsonBody(request("{not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("rejects an oversized body with a 413, before attempting to parse it", async () => {
    const oversized = JSON.stringify({ text: "x".repeat(DEFAULT_MAX_BODY_BYTES + 1) });
    const result = await readJsonBody(request(oversized));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("respects a caller-supplied maxBytes override", async () => {
    const body = JSON.stringify({ a: "x".repeat(100) });
    const result = await readJsonBody(request(body), 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("rejects a body whose stream errors while being read", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    const req = new Request("http://localhost/api/stories", {
      method: "POST",
      body,
      // Node's fetch requires this for a streaming request body.
      duplex: "half",
    } as RequestInit);

    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("accepts a body right at the boundary", async () => {
    // Pad so the whole JSON body's byte length lands exactly at the cap.
    const overhead = JSON.stringify({ a: "" }).length;
    const body = JSON.stringify({ a: "x".repeat(10 - overhead) });
    expect(Buffer.byteLength(body, "utf8")).toBe(10);

    const result = await readJsonBody(request(body), 10);
    expect(result.ok).toBe(true);
  });
});
