import { describe, expect, it } from "vitest";
import { splitDisplayName } from "./providerName";

describe("splitDisplayName", () => {
  it("splits a model name from its parenthesized vendor", () => {
    expect(splitDisplayName("Claude (Anthropic)")).toEqual({ name: "Claude", vendor: "Anthropic" });
  });

  it("falls back to an empty vendor when there is no parenthesized suffix", () => {
    expect(splitDisplayName("Claude")).toEqual({ name: "Claude", vendor: "" });
  });

  it("trims whitespace between the name and the vendor parenthesis", () => {
    expect(splitDisplayName("Llama 3.3 70B   (OpenRouter)")).toEqual({
      name: "Llama 3.3 70B",
      vendor: "OpenRouter",
    });
  });
});
