/**
 * Reduces an untrusted `callbackUrl` query param to a same-origin relative path.
 *
 * Origin resolution, not prefix matching: browsers normalize backslashes in special
 * schemes, so `/\evil.example` resolves to https://evil.example and would slip past a
 * `startsWith("//")` check — Next's router builds its navigation target the same way
 * (`new URL(addBasePath(href), location.href)`), so anything it would treat as external
 * has to be rejected here. `javascript:` inputs resolve to origin "null" and are caught
 * by the same comparison.
 *
 * `origin` is a parameter rather than a `window.location.origin` read so this stays
 * SSR-safe — call it from client event handlers, not during render.
 */
export function safeCallbackUrl(raw: string | null | undefined, origin: string): string {
  if (!raw) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
