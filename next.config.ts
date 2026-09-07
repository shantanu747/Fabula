import type { NextConfig } from "next";

// CSP lives in src/proxy.ts, not here — it needs a fresh nonce per request, and
// headers() has no access to one. Everything else is static and belongs here.
// See docs/adr/0024-security-headers-and-supply-chain.md.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Duplicates the CSP's own `frame-ancestors 'none'` — kept for browsers/proxies that
  // ignore CSP framing directives but still honor this older header.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
