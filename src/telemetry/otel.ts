/**
 * OpenTelemetry sink — subscribes to the SAME stream-json events as the
 * translator (source of truth) and turns them into OTLP traces + metrics for
 * the collector. Follows OTel GenAI semantic conventions (`gen_ai.*`).
 *
 * Traces:  one root span per run; a child span per tool call (opened on the
 *          Claude `tool_use`, closed on the matching `tool_result`).
 * Metrics: token counters (input/output/cache r+w), tool-invocation counter by
 *          tool name, and a cost histogram in USD.
 * Cost:    prefer `result.total_cost_usd` / `model_usage[].cost_usd`; fall back
 *          to the pricing table in config/model.ts (the gateway-swap basis).
 *
 * Degrades to a no-op if `@opentelemetry/api` isn't installed, so the bridge
 * runs without the telemetry deps during development. Wire the real SDK +
 * OTLP exporter via the astropods telemetry adapter (see README).
 *
 * Never records the API key or full env as span attributes.
 */

import { computeCostUsd } from "../config/model.ts";
import type { StreamJsonEvent } from "../types/streamjson.ts";

export interface Telemetry {
  onEvent(sessionId: string, ev: StreamJsonEvent): void;
  endSession(sessionId: string): void;
}

const NOOP: Telemetry = { onEvent() {}, endSession() {} };

interface OtelApi {
  trace: {
    getTracer: (name: string) => {
      startSpan: (name: string, opts?: unknown, ctx?: unknown) => { setAttribute: (k: string, v: unknown) => void; end: () => void; setStatus?: (s: unknown) => void };
    };
    setSpan: (ctx: unknown, span: unknown) => unknown;
  };
  context: { active: () => unknown };
  metrics: {
    getMeter: (name: string) => {
      createCounter: (n: string, o?: unknown) => { add: (v: number, a?: Record<string, unknown>) => void };
      createHistogram: (n: string, o?: unknown) => { record: (v: number, a?: Record<string, unknown>) => void };
    };
  };
}

/**
 * Build the real telemetry sink if OTel is present, else a no-op.
 * Assumes an OTLP exporter/provider is configured out-of-process by the
 * astropods adapter (OTEL_EXPORTER_OTLP_ENDPOINT etc.); we only use the API.
 */
export async function createTelemetry(serviceName = "claude-code-agui-bridge"): Promise<Telemetry> {
  let otel: OtelApi;
  try {
    otel = (await import("@opentelemetry/api")) as unknown as OtelApi;
  } catch {
    return NOOP;
  }

  const tracer = otel.trace.getTracer(serviceName);
  const meter = otel.metrics.getMeter(serviceName);
  const inputTokens = meter.createCounter("gen_ai.usage.input_tokens");
  const outputTokens = meter.createCounter("gen_ai.usage.output_tokens");
  const cacheReadTokens = meter.createCounter("gen_ai.usage.cache_read_tokens");
  const cacheWriteTokens = meter.createCounter("gen_ai.usage.cache_creation_tokens");
  const toolInvocations = meter.createCounter("gen_ai.tool.invocations");
  const costUsd = meter.createHistogram("gen_ai.usage.cost_usd");

  type Span = ReturnType<ReturnType<OtelApi["trace"]["getTracer"]>["startSpan"]>;
  interface Ctx {
    root: Span;
    rootCtx: unknown;
    model: string;
    toolSpans: Map<string, { span: Span; name: string }>;
  }
  const ctx = new Map<string, Ctx>();

  return {
    onEvent(sessionId, ev) {
      switch (ev.type) {
        case "system": {
          if ("subtype" in ev && ev.subtype === "init") {
            const model = ("model" in ev && ev.model) || "unknown";
            const root = tracer.startSpan("claude_code.run");
            root.setAttribute("gen_ai.system", "anthropic");
            root.setAttribute("gen_ai.operation.name", "agent");
            root.setAttribute("gen_ai.request.model", model);
            root.setAttribute("claude_code.session_id", sessionId);
            const rootCtx = otel.trace.setSpan(otel.context.active(), root);
            ctx.set(sessionId, { root, rootCtx, model, toolSpans: new Map() });
          }
          break;
        }
        case "assistant": {
          const c = ctx.get(sessionId);
          if (!c) break;
          for (const block of ev.message.content) {
            if (block.type === "tool_use") {
              const span = tracer.startSpan("claude_code.tool", undefined, c.rootCtx);
              span.setAttribute("gen_ai.tool.name", block.name);
              span.setAttribute("gen_ai.tool.call.id", block.id);
              c.toolSpans.set(block.id, { span, name: block.name });
              toolInvocations.add(1, { "gen_ai.tool.name": block.name });
            }
          }
          const u = ev.message.usage;
          if (u) {
            inputTokens.add(u.input_tokens ?? 0, { "gen_ai.request.model": c.model });
            outputTokens.add(u.output_tokens ?? 0, { "gen_ai.request.model": c.model });
          }
          break;
        }
        case "user": {
          const c = ctx.get(sessionId);
          if (!c) break;
          for (const block of ev.message.content) {
            if (block.type === "tool_result") {
              const t = c.toolSpans.get(block.tool_use_id);
              if (t) {
                t.span.setAttribute("claude_code.tool.is_error", Boolean(block.is_error));
                t.span.end();
                c.toolSpans.delete(block.tool_use_id);
              }
            }
          }
          break;
        }
        case "result": {
          const c = ctx.get(sessionId);
          if (!c) break;
          const u = ev.usage ?? {};
          cacheReadTokens.add(u.cache_read_input_tokens ?? 0, { "gen_ai.request.model": c.model });
          cacheWriteTokens.add(u.cache_creation_input_tokens ?? 0, { "gen_ai.request.model": c.model });
          const cost = ev.total_cost_usd ?? computeCostUsd(c.model, u) ?? 0;
          costUsd.record(cost, {
            "gen_ai.request.model": c.model,
            "claude_code.cost_source": ev.total_cost_usd != null ? "reported" : "computed",
          });
          c.root.setAttribute("gen_ai.usage.input_tokens", u.input_tokens ?? 0);
          c.root.setAttribute("gen_ai.usage.output_tokens", u.output_tokens ?? 0);
          c.root.setAttribute("claude_code.cost_usd", cost);
          c.root.setAttribute("claude_code.num_turns", ev.num_turns ?? 0);
          c.root.setAttribute("claude_code.is_error", Boolean(ev.is_error));
          break;
        }
      }
    },
    endSession(sessionId) {
      const c = ctx.get(sessionId);
      if (!c) return;
      for (const { span } of c.toolSpans.values()) span.end(); // close any leaked tool spans
      c.root.end();
      ctx.delete(sessionId);
    },
  };
}
