import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  bucketKey,
  clientIp,
  FEED_READ,
  GENERATE_GUEST,
  GENERATE_GUEST_UNIDENTIFIED,
  GENERATE_USER,
  REGISTER,
  REPORT,
  retryAfterSeconds,
  STORIES_READ,
  STORIES_WRITE,
} from "./policy";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/generate", { method: "POST", headers });
}

let savedHopCount: string | undefined;

afterEach(() => {
  if (savedHopCount === undefined) delete process.env.TRUSTED_PROXY_HOP_COUNT;
  else process.env.TRUSTED_PROXY_HOP_COUNT = savedHopCount;
});

function withHopCount(value: string) {
  savedHopCount = process.env.TRUSTED_PROXY_HOP_COUNT;
  process.env.TRUSTED_PROXY_HOP_COUNT = value;
}

describe("clientIp", () => {
  it("reads the rightmost x-forwarded-for entry by default (one trusted hop)", () => {
    // Vercel appends rather than rewrites: the entry it adds itself lands on
    // the right, and that is the one entry this deployment actually controls.
    const ip = clientIp(requestWith({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }));

    expect(ip).toBe("150.172.238.178");
  });

  it("ignores a spoofed left entry — the bug this replaces", () => {
    // An attacker controls everything left of what their own connection's hop
    // appended. Two requests differing only in their spoofed prefix must land
    // on the same bucket, not mint a fresh one each time.
    const spoofed1 = clientIp(requestWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }));
    const spoofed2 = clientIp(requestWith({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" }));

    expect(spoofed1).toBe("203.0.113.7");
    expect(spoofed2).toBe("203.0.113.7");
  });

  it.each([
    ["0", "203.0.113.7, 70.41.3.18, 150.172.238.178", undefined],
    ["1", "203.0.113.7, 70.41.3.18, 150.172.238.178", "150.172.238.178"],
    ["2", "203.0.113.7, 70.41.3.18, 150.172.238.178", "70.41.3.18"],
    ["3", "203.0.113.7, 70.41.3.18, 150.172.238.178", "203.0.113.7"],
  ])("TRUSTED_PROXY_HOP_COUNT=%s counts back that many entries from the right", (hopCount, header, expected) => {
    withHopCount(hopCount);

    const ip = clientIp(requestWith({ "x-forwarded-for": header }));

    // A hop count of 0 is nonsensical (treated as the default, 1) rather than
    // "trust nothing" or an out-of-range read — see trustedProxyHopCount().
    expect(ip).toBe(expected ?? "150.172.238.178");
  });

  it("treats a hop count exceeding the header's own entries as untrustworthy, not an out-of-range read", () => {
    withHopCount("5");

    const ip = clientIp(requestWith({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }));

    // Only 2 entries exist; a 5-hop-deep read can't have been written entirely
    // by infrastructure this deployment controls, so it falls back like an
    // absent header would.
    expect(ip).toBe("unknown");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(clientIp(requestWith({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it.each([
    ["neither header", {}],
    ["an empty x-forwarded-for", { "x-forwarded-for": "" }],
    ["a whitespace-only entry", { "x-forwarded-for": "  " }],
  ])("returns a stable placeholder for %s", (_label, headers) => {
    // Everyone unidentifiable shares one bucket, under a policy sized for a
    // shared population rather than one caller (see guard.ts's guardGenerate).
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

  it("caps the shared 'no proxy signal' guest bucket far more tightly than one identified guest", () => {
    // Every guest in this state shares the one bucket, so its sustained rate
    // must describe a population's budget, not one caller's.
    expect(GENERATE_GUEST_UNIDENTIFIED.refillPerSecond).toBeLessThan(GENERATE_GUEST.refillPerSecond);
  });

  it("keeps writes stricter than reads for the account-scoped routes", () => {
    expect(STORIES_WRITE.refillPerSecond).toBeLessThan(STORIES_READ.refillPerSecond);
  });

  it("makes REPORT the strictest policy in the file — it writes a row on every call", () => {
    const all = [GENERATE_USER, GENERATE_GUEST, REGISTER, STORIES_READ, STORIES_WRITE, FEED_READ];
    for (const policy of all) {
      expect(REPORT.refillPerSecond).toBeLessThan(policy.refillPerSecond);
    }
  });
});

describe("clientIp — a proxy header present but unusable", () => {
  it("treats a whitespace-only x-real-ip as no address at all", () => {
    // An empty key would put every such caller in a bucket named for nothing,
    // which is the same outcome as "unknown" but by accident rather than choice.
    expect(clientIp(requestWith({ "x-real-ip": "   " }))).toBe("unknown");
  });

  it("skips a blank leading entry rather than treating the whole header as unusable", () => {
    // A misconfigured proxy that prepends a separator before writing anything.
    // The blank entry is dropped before counting hops from the right, so the
    // one real entry that remains is still read correctly rather than the
    // whole header being discarded on account of it.
    expect(clientIp(requestWith({ "x-forwarded-for": ", 70.41.3.18" }))).toBe("70.41.3.18");
  });

  it("falls back to x-real-ip only when x-forwarded-for has no usable entries at all", () => {
    expect(clientIp(requestWith({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9"
    );
  });

  it("returns the placeholder when neither header has anything usable", () => {
    expect(clientIp(requestWith({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});
