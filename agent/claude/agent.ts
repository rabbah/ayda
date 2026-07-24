/**
 * Claude Agent SDK session source (default).
 *
 * Runs the Claude agent loop via the Claude Agent SDK's `query()` with the
 * `claude_code` system-prompt preset, instead of hand-spawning `claude -p` and
 * parsing NDJSON (see supervisor.ts for that fallback).
 *
 * We import the SDK through `@astropods/adapter-claude-agent-sdk` — a drop-in
 * re-export of `@anthropic-ai/claude-agent-sdk` whose `query()` is patched with
 * OpenInference OTel instrumentation wired to Astro's tracer provider. So
 * observability (query / sub-agent / tool / model spans) flows to the Astro
 * dashboard automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and is a
 * no-op locally — no native-CLI telemetry env needed.
 *
 * Why the SDK: a TYPED message stream instead of an unversioned stdout contract
 * (our #1 pin). NB it is NOT in-process — it still spawns the Claude Code binary
 * as a child (image must contain `claude`); its messages mirror the CLI's
 * stream-json envelopes (system/init, assistant, user, stream_event, result),
 * so the existing `Translator` consumes them unchanged.
 *
 * Presents the same surface as ClaudeSupervisor (start / sendUserMessage /
 * closeInput / stop + "event"/"exit"/"spawnError") so index.ts wires it identically.
 */

import { EventEmitter } from "node:events";
import { claudeSpawnEnv, type ResolvedModel } from "../config/model.ts";
import type { StreamJsonEvent } from "../types/streamjson.ts";

/**
 * Tools REMOVED from the model's context (bare deny rules). `allowedTools` only
 * auto-approves — it does NOT limit availability — so without this the claude_code
 * preset exposes its full toolset. We keep the coding essentials (Read/Edit/Write/
 * Bash/Grep/Glob/NotebookEdit) and strip:
 *   - WebSearch/WebFetch — Anthropic server tools, dead on the Bedrock-backed gateway
 *   - Task/Workflow — sub-agent + multi-agent orchestration (cost multipliers)
 *   - platform/harness tools irrelevant to one coding turn (cron, scheduling,
 *     messaging, skills, worktree, design, the Task* board tools)
 * Applied by default in BOTH paths: the in-process session and the sandbox (which
 * constructs this same class). Override via AgentSessionOptions.disallowedTools.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Task",
  "Workflow",
  "Skill",
  "SendMessage",
  "DesignSync",
  "ReportFindings",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
];

export interface AgentSessionOptions {
  model: ResolvedModel;
  allowedTools: string[];
  /** Tools removed from the model's context; defaults to DEFAULT_DISALLOWED_TOOLS. */
  disallowedTools?: string[];
  permissionMode?: string;
  resumeSessionId?: string;
  includePartialMessages?: boolean;
  cwd?: string;
  /** Extra instructions appended to the claude_code preset. */
  systemPromptAppend?: string;
  /** Per-user GitHub token (from OAuth) → injected as GH_TOKEN for git/gh. */
  githubToken?: string;
  /**
   * End user this run acts for (messaging StreamOptions.userId, or the resolved
   * web identity). Tagged on the run's trace as `langfuse.user.id` so the Astro
   * Traces page shows a User; empty/absent backfills "anonymous".
   */
  userId?: string;
}

type Events = {
  event: [StreamJsonEvent];
  exit: [number | null];
  spawnError: [Error];
};

/**
 * Minimal slice of `@opentelemetry/api` used to tag a run's trace with the end
 * user. Imported dynamically (see withUserTrace) so the bridge still runs when
 * the telemetry deps aren't installed, matching telemetry/otel.ts.
 */
interface OtelTraceApi {
  trace: {
    getTracer: (name: string) => {
      startSpan: (name: string) => { setAttribute: (k: string, v: unknown) => void; end: () => void };
    };
    setSpan: (ctx: unknown, span: unknown) => unknown;
  };
  context: {
    active: () => unknown;
    with: <T>(ctx: unknown, fn: () => T) => T;
  };
}

export class ClaudeAgentSession extends EventEmitter<Events> {
  private readonly opts: AgentSessionOptions;
  private q: { interrupt?: () => void } | null = null;

  constructor(opts: AgentSessionOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    /* no-op: the run begins on sendUserMessage (single-turn scaffold). */
  }

  /** Kick off a single-turn agent run. */
  sendUserMessage(text: string): void {
    void this.run(text).catch((err) => {
      this.emit("spawnError", err as Error);
      this.emit("exit", 1);
    });
  }

  closeInput(): void {
    /* no-op: a string-prompt query() runs to completion on its own. */
  }

  stop(): void {
    try {
      this.q?.interrupt?.();
    } catch {
      /* best-effort */
    }
  }

  private async run(prompt: string): Promise<void> {
    let query: (args: { prompt: string; options: unknown }) => AsyncIterable<unknown> & {
      interrupt?: () => void;
    };
    try {
      ({ query } = (await import("@astropods/adapter-claude-agent-sdk")) as {
        query: typeof query;
      });
    } catch (err) {
      throw new Error(`@astropods/adapter-claude-agent-sdk unavailable: ${(err as Error).message}`);
    }

    // Model/auth/gateway seam, plus this user's GitHub token (if connected) as
    // GH_TOKEN — git/gh use it via the image's credential helper. Telemetry is
    // handled by the adapter (OpenInference spans), so no native OTel env here.
    const childEnv: NodeJS.ProcessEnv = {
      ...claudeSpawnEnv(this.opts.model),
      ...(this.opts.githubToken ? { GH_TOKEN: this.opts.githubToken } : {}),
    };
    // On the gateway path the effective model id is bedrock/-prefixed and carried
    // in ANTHROPIC_MODEL by claudeSpawnEnv. The SDK's explicit `model` option
    // OVERRIDES that env var, so read it back and pass the same id — otherwise a
    // bare `claude-*` reaches the gateway and is rejected (401/403 "virtual key
    // not found"). Direct mode leaves ANTHROPIC_MODEL as the bare id, so this is
    // a no-op there.
    const effectiveModel = childEnv.ANTHROPIC_MODEL ?? this.opts.model.id;

    const options = {
      model: effectiveModel,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS,
      permissionMode: this.opts.permissionMode ?? "acceptEdits",
      includePartialMessages: this.opts.includePartialMessages ?? true,
      // Run LEAN to cut the child's cold-start + memory: don't scan the filesystem
      // for skills / subagents / slash-commands / CLAUDE.md (settingSources: []),
      // load no skills, and skip MCP discovery. Ada is a code agent (Read/Edit/
      // Write/Bash/Grep/Glob) — none of that is used. The claude_code preset,
      // model, and agentic loop (maxTurns) are deliberately KEPT.
      settingSources: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(this.opts.systemPromptAppend ? { append: this.opts.systemPromptAppend } : {}),
      },
      ...(this.opts.resumeSessionId ? { resume: this.opts.resumeSessionId } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      env: childEnv,
      // DEBUG: capture the CLI's stderr — gateway/API failures (Bifrost "model
      // not found", 4xx, auth) print here and don't always reach the result event.
      stderr: (data: unknown) =>
        console.error(`[claude:stderr] ${typeof data === "string" ? data : JSON.stringify(data)}`),
    };

    // Attach the end user to this run's trace so it shows up in Astro's "Traces"
    // page. The claude-agent-sdk adapter emits OpenInference spans but exposes no
    // hook for user identity, so we open a parent span carrying `langfuse.user.id`
    // and run query() inside its context: the adapter's spans nest under it (the
    // shared tracer provider registers a global context manager), Langfuse reads
    // the trace's user from the root span, and the OTLP ingester leaves the
    // attribute intact. Mirrors the langchain/mastra adapters.
    await this.withUserTrace(async () => {
      const q = query({ prompt, options });
      this.q = q;
      console.error(`[claude:run] starting model=${effectiveModel}`);
      // SDK messages mirror the CLI stream-json envelopes; the cast bridges the
      // SDK's typed union to ours so the Translator/telemetry consume them as-is.
      for await (const message of q) {
        const ev = message as StreamJsonEvent;
        // DEBUG: dump result / system / error-bearing events in full so a failed
        // run reveals its real cause instead of the generic "Claude Code run failed".
        const t = (ev as { type?: string }).type;
        if (t === "result" || t === "system" || (ev as { is_error?: boolean }).is_error) {
          console.error(`[claude:event ${t}] ${JSON.stringify(ev)}`);
        }
        this.emit("event", ev);
      }
    });
    this.emit("exit", 0);
  }

  /**
   * Run `fn` inside an OTel span whose `langfuse.user.id` is this run's end user,
   * so the adapter's nested spans inherit it and the run shows a User in the
   * Traces page. Backfills "anonymous" for an empty id (keeps unauthenticated
   * runs out of the "No user" bucket, matching the langchain/mastra adapters).
   * Degrades to calling `fn` directly when `@opentelemetry/api` is absent.
   */
  private async withUserTrace(fn: () => Promise<void>): Promise<void> {
    let otel: OtelTraceApi;
    try {
      otel = (await import("@opentelemetry/api")) as unknown as OtelTraceApi;
    } catch {
      await fn();
      return;
    }
    const span = otel.trace.getTracer("ada").startSpan("ada.agent.run");
    span.setAttribute("langfuse.user.id", this.opts.userId || "anonymous");
    const ctx = otel.trace.setSpan(otel.context.active(), span);
    try {
      await otel.context.with(ctx, fn);
    } finally {
      span.end();
    }
  }
}
