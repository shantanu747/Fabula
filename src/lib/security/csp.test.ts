import { describe, expect, it } from "vitest";
import { buildCsp, cspHeaderName, CSP_HEADER_NAME, CSP_REPORT_ONLY_HEADER_NAME } from "./csp";

const NONCE = "test-nonce-value";

describe("buildCsp", () => {
  it("includes every required directive", () => {
    const csp = buildCsp({ nonce: NONCE, isDev: false });
    for (const directive of [
      "default-src 'self'",
      "script-src",
      "style-src",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it("interpolates the nonce into both script-src and style-src", () => {
    const csp = buildCsp({ nonce: NONCE, isDev: false });
    expect(csp).toContain(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${NONCE}'`);
  });

  it("adds unsafe-eval and unsafe-inline only in dev", () => {
    const prod = buildCsp({ nonce: NONCE, isDev: false });
    const dev = buildCsp({ nonce: NONCE, isDev: true });

    expect(prod).not.toContain("unsafe-eval");
    expect(prod).not.toContain("unsafe-inline");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("'unsafe-inline'");
  });

  it("has no double spaces or a trailing double semicolon", () => {
    const csp = buildCsp({ nonce: NONCE, isDev: false });
    expect(csp).not.toMatch(/ {2,}/);
    expect(csp).not.toMatch(/;;/);
    expect(csp.endsWith(";")).toBe(true);
  });

  it("produces a different nonce on each call site's own value", () => {
    const first = buildCsp({ nonce: "aaa", isDev: false });
    const second = buildCsp({ nonce: "bbb", isDev: false });
    expect(first).not.toBe(second);
    expect(first).toContain("nonce-aaa");
    expect(second).toContain("nonce-bbb");
  });
});

describe("cspHeaderName", () => {
  it("picks the report-only header name when reportOnly is true", () => {
    expect(cspHeaderName(true)).toBe(CSP_REPORT_ONLY_HEADER_NAME);
  });

  it("picks the enforcing header name when reportOnly is false", () => {
    expect(cspHeaderName(false)).toBe(CSP_HEADER_NAME);
  });
});
