/**
 * Supervises one headless `claude -p` process over stream-json (NDJSON both ways).
 *
 * - Spawns claude with the configured flags (no TTY; stdio pipes only).
 * - Parses newline-delimited JSON from stdout into typed stream-json events and
 *   emits them (`"event"`), so translator/telemetry/persistence can each
 *   subscribe to the same source of truth.
 * - Writes user turns to stdin as NDJSON.
 * - The process is owned by the session, NOT by any client connection: a client
 *   disconnecting does not kill it. Reconnect happens at the transport layer.
 *
 * Never logs the child env or the API key.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { claudeSpawnEnv, type ResolvedModel } from "../config/model.ts";
import type { StreamJsonEvent, UserInputMessage } from "../types/streamjson.ts";

export interface SupervisorOptions {
  model: ResolvedModel;
  allowedTools: string[]; // e.g. ["Read","Edit","Bash","Grep"]
  permissionMode?: string; // e.g. "acceptEdits"
  /** Resume an existing Claude session instead of starting fresh. */
  resumeSessionId?: string;
  /** Path to the claude binary. Default "claude". */
  bin?: string;
  cwd?: string;
  /** Emit token-level deltas (maps to nicer AG-UI streaming). Default true. */
  includePartialMessages?: boolean;
}

type Events = {
  event: [StreamJsonEvent];
  parseError: [Error, string];
  exit: [number | null];
  spawnError: [Error];
};

export class ClaudeSupervisor extends EventEmitter<Events> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readonly opts: SupervisorOptions;

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    if (this.child) throw new Error("supervisor already started");

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose", // required for stream-json output
      ...(this.opts.includePartialMessages ?? true ? ["--include-partial-messages"] : []),
      "--permission-mode", this.opts.permissionMode ?? "acceptEdits",
      "--allowedTools", this.opts.allowedTools.join(","),
      "--model", this.opts.model.id,
      ...(this.opts.resumeSessionId ? ["--resume", this.opts.resumeSessionId] : []),
    ];

    const child = spawn(this.opts.bin ?? "claude", args, {
      cwd: this.opts.cwd,
      env: claudeSpawnEnv(this.opts.model), // NB: never log this
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (err) => this.emit("spawnError", err));
    child.on("exit", (code) => {
      this.rl?.close();
      this.emit("exit", code);
    });

    // stderr may carry diagnostics; forward to logs WITHOUT the env/args dump.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[claude:stderr] ${chunk}`);
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.emit("event", JSON.parse(trimmed) as StreamJsonEvent);
      } catch (err) {
        this.emit("parseError", err as Error, trimmed);
      }
    });
  }

  /** Send a user turn. `sessionId` is optional on the first message. */
  sendUserMessage(text: string, sessionId?: string): void {
    if (!this.child) throw new Error("supervisor not started");
    const msg: UserInputMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      ...(sessionId ? { session_id: sessionId } : {}),
      parent_tool_use_id: null,
    };
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Signal end-of-input (Claude finishes the turn and emits `result`). */
  closeInput(): void {
    this.child?.stdin.end();
  }

  /** Terminate the process (e.g. explicit cancel — NOT on client disconnect). */
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
  }
}
