import { registerOTel } from "@vercel/otel";

/**
 * Called once per server instance, in every Next.js runtime (Node and Edge —
 * proxy.ts runs on Edge, so this file must stay free of `node:`-only imports).
 * `@vercel/otel` is a thin, vendor-neutral configuration wrapper: with no
 * OTEL_EXPORTER_OTLP_ENDPOINT set, it's a no-op rather than a crash, so this is
 * safe to run unconditionally in every environment, including CI and local dev
 * with no collector configured.
 */
export function register() {
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "fabula" });
}
