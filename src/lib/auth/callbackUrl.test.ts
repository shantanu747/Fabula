import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "./callbackUrl";

const ORIGIN = "https://fabula.example";

describe("safeCallbackUrl", () => {
  it("returns / for a missing value", () => {
    expect(safeCallbackUrl(null, ORIGIN)).toBe("/");
    expect(safeCallbackUrl(undefined, ORIGIN)).toBe("/");
    expect(safeCallbackUrl("", ORIGIN)).toBe("/");
  });

  it("preserves a same-origin relative path, including search and hash", () => {
    expect(safeCallbackUrl("/library", ORIGIN)).toBe("/library");
    expect(safeCallbackUrl("/story?id=42#top", ORIGIN)).toBe("/story?id=42#top");
  });

  it("preserves a same-origin absolute URL as a relative path", () => {
    expect(safeCallbackUrl(`${ORIGIN}/feed`, ORIGIN)).toBe("/feed");
  });

  it("rejects a foreign-origin absolute URL", () => {
    expect(safeCallbackUrl("https://evil.example/phish", ORIGIN)).toBe("/");
  });

  it("rejects protocol-relative URLs that resolve off-origin", () => {
    expect(safeCallbackUrl("//evil.example", ORIGIN)).toBe("/");
  });

  // Regression: browsers normalize backslashes to forward slashes in special-scheme
  // URLs, so a naive `startsWith("/") && !startsWith("//")` check lets this through
  // while it still resolves off-origin. See docs/adr/0011.
  it("rejects backslash-prefixed values that normalize to a foreign origin", () => {
    expect(safeCallbackUrl("/\\evil.example", ORIGIN)).toBe("/");
    expect(safeCallbackUrl("\\\\evil.example", ORIGIN)).toBe("/");
  });

  it("rejects javascript: URLs", () => {
    expect(safeCallbackUrl("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  it("rejects unparseable input", () => {
    expect(safeCallbackUrl("http://", ORIGIN)).toBe("/");
  });
});
