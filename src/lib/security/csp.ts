export interface BuildCspOptions {
  nonce: string;
  isDev: boolean;
}

/**
 * `'strict-dynamic'` makes the plain host/scheme allowances in `script-src` inert in
 * browsers that support it (Next.js's own guidance) — they only matter as a fallback for
 * ones that don't. `style-src` gets `'unsafe-inline'` only in dev because Next's dev
 * server injects Fast-Refresh styles without the request nonce attached; a real
 * `next build && next start` was used to confirm production doesn't need it (Tailwind's
 * production CSS ships as a linked stylesheet, not inline `<style>` tags).
 *
 * No `reportOnly` param: report-only vs. enforcing only changes which response header
 * name carries this string (`proxy.ts`'s job), never the policy's content.
 */
export function buildCsp({ nonce, isDev }: BuildCspOptions): string {
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ""}`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ];

  return directives.join("; ") + ";";
}

export const CSP_HEADER_NAME = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";

export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? CSP_REPORT_ONLY_HEADER_NAME : CSP_HEADER_NAME;
}
