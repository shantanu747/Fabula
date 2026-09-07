import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProvider, isConfigured, PROVIDERS, suggestAlternative } from "./registry";

// CI sets ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY at the job level
// (see ci.yml) so `next build` succeeds; a suite that wants to assert on the
// *absence* of a key must not depend on the ambient environment being clean,
// the same trap AGENTS.md documents for DATABASE_URL. Save and fully clear all
// three before each test, restore after.
const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_VARS.map((v) => [v, process.env[v]]));
  for (const v of ENV_VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("isConfigured", () => {
  it("is false for every provider when no keys are set", () => {
    for (const id of Object.keys(PROVIDERS)) expect(isConfigured(id)).toBe(false);
  });

  it("is true only for a provider whose key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isConfigured("openai")).toBe(true);
    expect(isConfigured("anthropic")).toBe(false);
    expect(isConfigured("openrouter")).toBe(false);
  });

  it("is false for an id with no known env var mapping", () => {
    expect(isConfigured("does-not-exist")).toBe(false);
  });
});

describe("suggestAlternative", () => {
  it("returns undefined when nothing else is configured", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(suggestAlternative("anthropic")).toBeUndefined();
  });

  it("returns undefined when nothing at all is configured", () => {
    expect(suggestAlternative("anthropic")).toBeUndefined();
  });

  it("picks the first configured provider other than the excluded one, in registry order", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENROUTER_API_KEY = "sk-test";
    // Registry order is anthropic, openai, openrouter — excluding anthropic
    // (which was never configured anyway) should still surface openai first.
    expect(suggestAlternative("anthropic")).toBe("openai");
  });

  it("picks the earliest configured provider in registry order, not just any configured one", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENROUTER_API_KEY = "sk-test";
    // Excluding the middle entry: anthropic (first in registry order) must win
    // over openrouter (last), proving this isn't just "any other configured id".
    expect(suggestAlternative("openai")).toBe("anthropic");
  });

  it("never suggests the excluded provider even if it is configured", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(suggestAlternative("anthropic")).toBeUndefined();
  });
});

describe("getProvider", () => {
  it("still returns the fully registered provider object", () => {
    // Sanity check that isConfigured/suggestAlternative are additive to the
    // existing registry lookup, not a replacement for it.
    expect(getProvider("anthropic")?.id).toBe("anthropic");
  });
});
