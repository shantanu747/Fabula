import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  bucketKey,
  clientIp,
  GENERATE_GUEST,
  GENERATE_USER,
  REGISTER,
  retryAfterSeconds,
} from "./policy";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/generate", { method: "POST", headers });
}

describe("clientIp", () => {
  it("takes the original client from the left of x-forwarded-for", () => {
    // The platform rewrites this header on the way in, so the leftmost entry is
    // the caller and the rest are proxies it passed through.
    const ip = clientIp(requestWith({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }));

    expect(ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientIp(requestWith({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it.each([
    ["neither header", {}],
    ["an empty x-forwarded-for", { "x-forwarded-for": "" }],
    ["a whitespace-only entry", { "x-forwarded-for": "  " }],
  ])("returns a stable placeholder for %s", (_label, headers) => {
    // Everyone unidentifiable shares one bucket. That is stricter than giving
    // each of them their own, which is the right way round for a limiter.
    expect(clientIp(requestWith(headers))).toBe("unknown");
  });
});

describe("bucketKey", () => {
  it("separates the same caller's buckets by scope", () => {
    expect(bucketKey(GENERATE_GUEST, "203.0.113.7")).not.toBe(bucketKey(REGISTER, "203.0.113.7"));
  });

  it("gives different callers different buckets", () => {
    expect(bucketKey(GENERATE_GUEST, "203.0.113.7")).not.toBe(
      bucketKey(GENERATE_GUEST, "203.0.113.8")
    );
  });

  it("is stable for the same caller", () => {
    expect(bucketKey(GENERATE_USER, "user-1")).toBe(bucketKey(GENERATE_USER, "user-1"));
  });

  it("does not store the identity in the key", () => {
    // The table would otherwise be a record of which addresses used the app and
    // when, which is more than a counter needs to hold.
    const ip = "203.0.113.7";

    expect(bucketKey(GENERATE_GUEST, ip)).not.toContain(ip);
  });
});

describe("retryAfterSeconds", () => {
  it("tells an exhausted caller how long a full token takes to accrue", () => {
    // GENERATE_GUEST refills one token per 30 seconds.
    expect(retryAfterSeconds(GENERATE_GUEST, 0, 0)).toBe(30);
  });

  it("counts the time already elapsed", () => {
    expect(retryAfterSeconds(GENERATE_GUEST, 0, 15)).toBe(15);
  });

  it("never tells a client to retry immediately", () => {
    // A zero would let a client that honours Retry-After spin at full speed.
    expect(retryAfterSeconds(GENERATE_GUEST, 0.999, 0)).toBeGreaterThanOrEqual(1);
  });

  it("returns the floor of one second once a token is already available", () => {
    expect(retryAfterSeconds(GENERATE_GUEST, 3, 0)).toBe(1);
  });

  it("is always a positive whole number of seconds", () => {
    // Retry-After is an HTTP header: a fraction or a negative is not a value a
    // client can act on.
    fc.assert(
      fc.property(
        fc.constantFrom(GENERATE_GUEST, GENERATE_USER, REGISTER),
        fc.double({ min: 0, max: 25, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (policy, tokens, secondsSince) => {
          const seconds = retryAfterSeconds(policy, tokens, secondsSince);

          expect(Number.isInteger(seconds)).toBe(true);
          expect(seconds).toBeGreaterThanOrEqual(1);
          // Never longer than filling an empty bucket to one token.
          expect(seconds).toBeLessThanOrEqual(Math.ceil(1 / policy.refillPerSecond));
        }
      )
    );
  });
});

describe("the policies themselves", () => {
  it("gives a signed-in Writer more headroom than an anonymous caller", () => {
    // A guest is identified only by an address they may share with a household,
    // and every call spends provider tokens.
    expect(GENERATE_USER.capacity).toBeGreaterThan(GENERATE_GUEST.capacity);
    expect(GENERATE_USER.refillPerSecond).toBeGreaterThan(GENERATE_GUEST.refillPerSecond);
  });

  it("allows a burst large enough to never interrupt real writing", () => {
    // A paragraph takes a person far longer than a token takes to refill, so the
    // limit should be invisible to anyone actually writing a story.
    expect(GENERATE_GUEST.capacity).toBeGreaterThanOrEqual(5);
  });
});

describe("clientIp — a proxy header present but unusable", () => {
  it("treats a whitespace-only x-real-ip as no address at all", () => {
    // An empty key would put every such caller in a bucket named for nothing,
    // which is the same outcome as "unknown" but by accident rather than choice.
    expect(clientIp(requestWith({ "x-real-ip": "   " }))).toBe("unknown");
  });

  it("falls through to x-real-ip when x-forwarded-for has an empty leading entry", () => {
    // A misconfigured proxy that prepends a separator before writing anything.
    // The header is non-empty, so a naive check accepts it and then keys every
    // such caller under the empty string.
    expect(clientIp(requestWith({ "x-forwarded-for": ", 70.41.3.18", "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9"
    );
  });

  it("returns the placeholder when both headers are unusable", () => {
    expect(clientIp(requestWith({ "x-forwarded-for": ", 70.41.3.18" }))).toBe("unknown");
  });
});
