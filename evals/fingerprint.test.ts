import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintPayload, judgementCacheKey, type EvalRequestPayload } from "./fingerprint";

function payload(overrides: Partial<EvalRequestPayload> = {}): EvalRequestPayload {
  return {
    model: "claude-sonnet-5",
    maxTokens: 600,
    systemPrompt: "You are a collaborative fiction co-writer…",
    messages: [
      { role: "user", content: "The lighthouse had gone dark." },
      { role: "assistant", content: "Mara climbed the tower." },
    ],
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("is insensitive to key insertion order", () => {
    const a = { model: "m", maxTokens: 600, systemPrompt: "s", messages: [] };
    const b = { messages: [], systemPrompt: "s", maxTokens: 600, model: "m" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts nested keys too", () => {
    const a = { outer: { b: 1, a: 2 } };
    const b = { outer: { a: 2, b: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("fingerprintPayload", () => {
  it("is stable across repeated hashing of the same payload", () => {
    expect(fingerprintPayload(payload())).toBe(fingerprintPayload(payload()));
  });

  it("is insensitive to key insertion order in the payload", () => {
    const ordered = payload();
    const reversed: EvalRequestPayload = {
      messages: payload().messages,
      systemPrompt: payload().systemPrompt,
      maxTokens: payload().maxTokens,
      model: payload().model,
    };
    expect(fingerprintPayload(reversed)).toBe(fingerprintPayload(ordered));
  });

  it("changes when the system prompt changes", () => {
    const changed = payload({ systemPrompt: payload().systemPrompt + " One extra rule." });
    expect(fingerprintPayload(changed)).not.toBe(fingerprintPayload(payload()));
  });

  it("changes when a message changes, and when the model changes", () => {
    const differentMessage = payload({
      messages: [payload().messages[0], { role: "assistant", content: "Mara turned away." }],
    });
    expect(fingerprintPayload(differentMessage)).not.toBe(fingerprintPayload(payload()));
    const differentModel = payload({ model: "claude-opus-5" });
    expect(fingerprintPayload(differentModel)).not.toBe(fingerprintPayload(payload()));
  });
});

describe("judgementCacheKey", () => {
  it("concatenates text + caseId + rubricVersion exactly (order is load-bearing)", () => {
    const key = judgementCacheKey("abc", "case-1", "1");
    expect(key).toHaveLength(64); // sha256 hex
    expect(judgementCacheKey("abc", "case-1", "1")).toBe(key);
    expect(judgementCacheKey("abc", "case-1", "2")).not.toBe(key);
    expect(judgementCacheKey("abd", "case-1", "1")).not.toBe(key);
    expect(judgementCacheKey("abc", "case-2", "1")).not.toBe(key);
  });
});
