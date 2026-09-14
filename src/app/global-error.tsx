"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

/**
 * Catches a throw in the root layout itself (`src/app/layout.tsx` calls
 * `auth()`) — the one place `error.tsx` cannot reach, since `error.tsx` never
 * wraps the `layout.tsx`/`template.tsx` at its own segment (only `page.tsx`
 * and nested segments). Replaces the entire root layout when active, so per
 * Next's docs this must define its own `<html>`/`<body>` and cannot rely on
 * `globals.css`, Tailwind, or the app's CSS custom properties — none of that
 * is loaded outside the layout this file replaces. Styled with inline styles
 * and a literal `<style>` tag (which works fine; it just can't reference an
 * external stylesheet) approximating the app's palette (`globals.css`'s
 * `--background`/`--foreground`/`--accent`) rather than matching it exactly.
 *
 * Same reasoning as the root `error.tsx` for using a plain `<a>` rather than
 * `next/link`: the router itself may be what's broken, and a full document
 * load is the only recovery path guaranteed not to depend on it.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[global error boundary]", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <style>{`
          :root { --bg: #f3f2f2; --fg: #201f1d; --muted: rgba(32, 31, 29, 0.66); --accent: #b68235; }
          @media (prefers-color-scheme: dark) {
            :root { --bg: #191817; --fg: #eceae6; --muted: rgba(236, 234, 230, 0.55); --accent: #e1ad66; }
          }
        `}</style>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg)",
            color: "var(--fg)",
            fontFamily: "Georgia, serif",
            padding: "24px",
          }}
        >
          <div style={{ width: "100%", maxWidth: "420px", textAlign: "center" }}>
            <h1 style={{ fontSize: "28px", fontWeight: 400, lineHeight: 1.2, margin: 0 }}>
              Something went wrong
            </h1>
            <p style={{ marginTop: "12px", fontSize: "14px", lineHeight: 1.7, color: "var(--muted)" }}>
              Fabula hit a problem it couldn&apos;t recover from. This is usually temporary.
            </p>
            {error.digest && (
              <p style={{ marginTop: "8px", fontSize: "12px", color: "var(--muted)" }}>
                Reference: {error.digest}
              </p>
            )}
            <div
              style={{
                marginTop: "32px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                alignItems: "stretch",
              }}
            >
              <button
                type="button"
                onClick={() => retry()}
                style={{
                  minHeight: "44px",
                  border: "1px solid var(--accent)",
                  borderRadius: "4px",
                  background: "var(--accent)",
                  color: "var(--bg)",
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                style={{
                  minHeight: "44px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid var(--muted)",
                  borderRadius: "4px",
                  color: "var(--fg)",
                  fontSize: "14px",
                  textDecoration: "none",
                }}
              >
                Start a new story
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
