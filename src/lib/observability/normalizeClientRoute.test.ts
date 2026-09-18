import { describe, expect, it } from "vitest";
import { normalizeClientRoute } from "./normalizeClientRoute";

describe("normalizeClientRoute", () => {
  it.each([
    ["/", "/"],
    ["/story", "/story"],
    ["/story/", "/story"],
    ["/library", "/library"],
    ["/feed", "/feed"],
    ["/feed/some-real-story-id-123", "/feed/[id]"],
    ["/feed/some-real-story-id-123/", "/feed/[id]"],
    ["/login", "/login"],
    ["/signup", "/signup"],
    ["/forgot", "/forgot"],
    ["/reset", "/reset"],
    ["/verify", "/verify"],
  ])("buckets %s to %s", (input, expected) => {
    expect(normalizeClientRoute(input)).toBe(expected);
  });

  it("buckets anything unrecognized to other", () => {
    expect(normalizeClientRoute("/some/unknown/path")).toBe("other");
    expect(normalizeClientRoute("/admin")).toBe("other");
  });

  it("buckets a non-string, empty, or oversized value to other rather than throwing", () => {
    expect(normalizeClientRoute(undefined)).toBe("other");
    expect(normalizeClientRoute(null)).toBe("other");
    expect(normalizeClientRoute(42)).toBe("other");
    expect(normalizeClientRoute("")).toBe("other");
    expect(normalizeClientRoute("/" + "a".repeat(500))).toBe("other");
  });

  it("does not let a story id that happens to look like a known route slip through as that route", () => {
    // /feed/[id] is the one case where the segment IS meant to vary — this
    // just confirms an id can't accidentally collide with a *different*
    // known template.
    expect(normalizeClientRoute("/feed/login")).toBe("/feed/[id]");
  });
});
