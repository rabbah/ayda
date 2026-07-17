/**
 * OpenTelemetry SDK bootstrap.
 *
 * We are NOT a LangChain/Mastra agent, so the Astropods `serve()` telemetry
 * adapters don't apply. The platform's telemetry guidance for other frameworks
 * is: emit via the OTEL SDK using OTEL_EXPORTER_OTLP_ENDPOINT (injected by the
 * runner). That's what this does — it wires the global tracer/meter providers so
 * the spans/metrics produced in telemetry/otel.ts are actually exported.
 *
 * - Traces are the primary platform view and are ON whenever the endpoint is set.
 *   Per-run tool usage, token counts, and cost all ride on span attributes, so
 *   traces alone answer "tool usage + token usage → money".
 * - Metrics are OPT-IN (OTEL_METRICS_ENABLED=1) — not every collector ingests
 *   OTLP metrics, and we don't want periodic export errors by default.
 *
 * Exporter is OTLP/proto (matches the proven setup in sibling repos). Versions
 * mirror the repos' 0.217.0 train — reconcile at build if the platform bumps.
 *
 * Dynamic imports + guards so `node agent/index.ts` still runs locally without the
 * OTel deps installed (telemetry silently no-ops), matching the demo's design.
 */

let sdk: { shutdown: () => Promise<void> } | null = null;

export async function startTelemetrySdk(): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Native Claude Code OTel (via the SDK child) is the default telemetry source.
  // This wrapper-level exporter is OPT-IN to avoid double-emitting spans — turn
  // it on with BRIDGE_SELF_TELEMETRY=1 if you also want bridge/session spans.
  if (!endpoint || process.env.BRIDGE_SELF_TELEMETRY !== "1") {
    console.log("[bridge] wrapper self-telemetry off (native Claude Code OTel is the source; set BRIDGE_SELF_TELEMETRY=1 + OTLP endpoint to also emit bridge spans)");
    return false;
  }
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");

    const traceExporter = new OTLPTraceExporter(); // reads OTEL_EXPORTER_OTLP_ENDPOINT

    const metricsOn = process.env.OTEL_METRICS_ENABLED === "1";
    let metricReader: unknown;
    if (metricsOn) {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      metricReader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
    }

    const instance = new NodeSDK(metricReader ? { traceExporter, metricReader } : { traceExporter });
    instance.start();
    sdk = instance;
    console.log(`[bridge] OTel SDK started → ${endpoint} (traces${metricsOn ? " + metrics" : ""})`);
    return true;
  } catch (err) {
    console.warn(`[bridge] OTel SDK not started (deps missing or init failed): ${(err as Error).message}`);
    return false;
  }
}

/** Flush and shut down the SDK — call on process exit so short runs don't lose spans. */
export async function shutdownTelemetrySdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* best-effort flush */
  }
  sdk = null;
}

/**
 * Native Claude Code OTel env for the SDK/CLI child process. Claude Code emits
 * its own OTLP traces/metrics/logs (`claude_code.interaction` / `.llm_request`
 * / `.tool` spans + token/cost metrics) when these are set. We enable it ONLY
 * when an OTLP endpoint is present, so we don't spew localhost export errors
 * when it's unset (e.g. local dev without the runner). Respects any values the
 * runner already injected.
 */
export function claudeCodeTelemetryEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return base;
  return {
    ...base,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: base.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ?? "1",
    OTEL_TRACES_EXPORTER: base.OTEL_TRACES_EXPORTER ?? "otlp",
    OTEL_METRICS_EXPORTER: base.OTEL_METRICS_EXPORTER ?? "otlp",
    OTEL_LOGS_EXPORTER: base.OTEL_LOGS_EXPORTER ?? "otlp",
    // Short intervals so short runs actually flush before exit.
    OTEL_METRIC_EXPORT_INTERVAL: base.OTEL_METRIC_EXPORT_INTERVAL ?? "10000",
    OTEL_LOGS_EXPORT_INTERVAL: base.OTEL_LOGS_EXPORT_INTERVAL ?? "5000",
  };
}
