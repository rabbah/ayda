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

export interface AgentSessionOptions {
  model: ResolvedModel;
  allowedTools: string[];
  permissionMode?: string;
  resumeSessionId?: string;
  includePartialMessages?: boolean;
  cwd?: string;
  /** Extra instructions appended to the claude_code preset. */
  systemPromptAppend?: string;
  /** Per-user GitHub token (from OAuth) → injected as GH_TOKEN for git/gh. */
  githubToken?: string;
}

type Events = {
  event: [StreamJsonEvent];
  exit: [number | null];
  spawnError: [Error];
};

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

    const options = {
      model: this.opts.model.id,
      allowedTools: this.opts.allowedTools,
      permissionMode: this.opts.permissionMode ?? "acceptEdits",
      includePartialMessages: this.opts.includePartialMessages ?? true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(this.opts.systemPromptAppend ? { append: this.opts.systemPromptAppend } : {}),
      },
      ...(this.opts.resumeSessionId ? { resume: this.opts.resumeSessionId } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      // Model/auth/gateway seam, plus this user's GitHub token (if connected) as
      // GH_TOKEN — git/gh use it via the image's credential helper. Telemetry is
      // handled by the adapter (OpenInference spans), so no native OTel env here.
      env: {
        ...claudeSpawnEnv(this.opts.model),
        ...(this.opts.githubToken ? { GH_TOKEN: this.opts.githubToken } : {}),
      },
    };

    const q = query({ prompt, options });
    this.q = q;
    // SDK messages mirror the CLI stream-json envelopes; the cast bridges the
    // SDK's typed union to ours so the Translator/telemetry consume them as-is.
    for await (const message of q) {
      this.emit("event", message as StreamJsonEvent);
    }
    this.emit("exit", 0);
  }
}
