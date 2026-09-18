import { registerOTel } from "@vercel/otel";
import type { MetricReader } from "@opentelemetry/sdk-metrics";

/**
 * Called once per server instance, in every Next.js runtime (Node and Edge —
 * proxy.ts runs on Edge, so this file must stay free of `node:`-only imports).
 * `@vercel/otel` is a thin, vendor-neutral configuration wrapper: with no
 * OTEL_EXPORTER_OTLP_ENDPOINT set, it's a no-op rather than a crash, so this is
 * safe to run unconditionally in every environment, including CI and local dev
 * with no collector configured.
 *
 * **Metrics need an explicit `metricReaders` entry — traces do not.**
 * `registerOTel`'s `traceExporter` defaults to `"auto"`, which reads
 * `OTEL_EXPORTER_OTLP_ENDPOINT` itself; `metricReaders` has no such default
 * (confirmed by reading `@vercel/otel`'s own source — `dist/node/index.js`
 * only constructs a `MeterProvider` at all when `metricReaders` or `views`
 * is passed). Without a reader, every `metrics.getMeter()` call throughout
 * `src/lib/observability/metrics.ts` would resolve against the OTel API's
 * global no-op meter forever, silently — every instrument would exist and
 * every `.record()`/`.add()` call would succeed, and nothing would ever be
 * exported.
 *
 * The reader itself, and the OTLP metric exporter it wraps, live in
 * `instrumentation.metrics.ts` and are reached only through a dynamic
 * `import()` gated on `NEXT_RUNTIME === "nodejs"` — following the pattern
 * Next's own docs give for runtime-specific instrumentation code (see
 * `node_modules/next/dist/docs/.../instrumentation.md`'s "Specifying the
 * runtime" section) rather than a static top-level import here. Metrics
 * export is a Node.js-process concern; a static import of
 * `@opentelemetry/exporter-metrics-otlp-proto` here would pull a
 * Node-oriented HTTP/zlib-based exporter into the Edge bundle `proxy.ts`
 * shares this file with, which Next's own edge runtime cannot run.
 */
export async function register() {
  const metricReaders: MetricReader[] =
    process.env.NEXT_RUNTIME === "nodejs" ? (await import("./instrumentation.metrics")).createMetricReaders() : [];

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "fabula",
    metricReaders,
  });
}
