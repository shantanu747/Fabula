import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";

/**
 * Node.js-only: reached from `instrumentation.ts` via a dynamic import gated
 * on `NEXT_RUNTIME === "nodejs"`, never imported statically, so its
 * Node-oriented HTTP/zlib-based OTLP exporter never has to be bundled for
 * the Edge runtime `proxy.ts` and `instrumentation.ts` itself both run in.
 *
 * Same "no endpoint configured is a no-op, not a crash" posture as
 * `@vercel/otel`'s own trace-exporter default — an empty `metricReaders`
 * array means `@vercel/otel` never constructs a `MeterProvider` at all (see
 * `instrumentation.ts`'s own doc comment), which is exactly the state CI and
 * an unconfigured local `npm run dev` are already in today.
 */
export function createMetricReaders(): MetricReader[] {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return [];
  return [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })];
}
