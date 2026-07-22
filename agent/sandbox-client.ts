/**
 * Client for the isolated execution sandbox (the "gold standard" split).
 *
 * When SANDBOX_URL is set, Claude Code runs in a SEPARATE, secret-less container
 * (see sandbox/index.ts) reached over HTTP/SSE — so a rogue `bash` in one thread
 * can't read the control plane's DB, GitHub tokens, HMAC secret, or other users'
 * data. The control plane forwards only what a run needs: the model credential
 * (deploy-constant) and the per-user GH_TOKEN (per request).
 *
 * `SandboxSession` presents the SAME surface as ClaudeAgentSession
 * (start / sendUserMessage / closeInput / stop + "event"/"exit"/"spawnError"), so
 * callers swap the constructor and nothing else changes. The sandbox streams raw
 * stream-json events; the control plane still owns the Translator / telemetry.
 */

import { EventEmitter } from "node:events";
import type { ResolvedModel } from "./config/model.ts";
import type { StreamJsonEvent } from "./types/streamjson.ts";
import type { RepoSpec } from "./session/repo.ts";

/**
 * Resolve the sandbox base URL: an explicit SANDBOX_URL, else the platform-
 * injected knowledge-container host (`knowledge.sandbox` → KNOWLEDGE_SANDBOX_HOST
 * /PORT). So deploying the sandbox container flips execution to it automatically;
 * a bare `node agent/index.ts` with neither set stays in-process.
 */
function resolveSandboxBase(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SANDBOX_URL) return env.SANDBOX_URL.replace(/\/+$/, "");
  const host = env.KNOWLEDGE_SANDBOX_HOST;
  if (host) return `http://${host}:${env.KNOWLEDGE_SANDBOX_PORT ?? "3000"}`;
  return null;
}

/** True when execution should route to the sandbox container. */
export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSandboxBase(env) !== null;
}

function sandboxUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveSandboxBase(env);
  if (!base) throw new Error("sandbox not configured (SANDBOX_URL / KNOWLEDGE_SANDBOX_HOST unset)");
  return `${base}${path}`;
}

/**
 * Model credentials the sandbox needs to reach the API. Deploy-constant (not
 * per-user), forwarded so the sandbox container holds no model secret at rest.
 * config/model.ts in the sandbox turns these into the child's ANTHROPIC_* env.
 */
function modelCreds(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = [
    "ASTRO_GATEWAY_URL",
    "ASTRO_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k]) out[k] = env[k] as string;
  return out;
}

/** Ask the sandbox to clone/reuse a repo for a conversation (the `work on` path). */
export async function sandboxEnsureRepo(
  workspaceKey: string,
  spec: RepoSpec,
  githubToken: string | undefined,
): Promise<{ dir: string; cloned: boolean }> {
  const res = await fetch(sandboxUrl("/ensure-repo"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceKey, owner: spec.owner, repo: spec.repo, githubToken }),
  });
  if (!res.ok) throw new Error(`sandbox ensure-repo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { dir: string; cloned: boolean };
}

export interface SandboxSessionOptions {
  model: ResolvedModel;
  allowedTools: string[];
  permissionMode?: string;
  resumeSessionId?: string;
  githubToken?: string;
  /** Stable per-conversation key; the sandbox owns the workspace dir for it. */
  workspaceKey: string;
  /** Repo bound to this thread (one per thread); the sandbox checks it out. */
  repo?: RepoSpec;
  /** End user this run acts for; forwarded so the sandbox tags the run's trace. */
  userId?: string;
}

type Events = {
  event: [StreamJsonEvent];
  exit: [number | null];
  spawnError: [Error];
};

export class SandboxSession extends EventEmitter<Events> {
  private readonly opts: SandboxSessionOptions;
  private readonly controller = new AbortController();

  constructor(opts: SandboxSessionOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    /* no-op: the run begins on sendUserMessage (single-turn), same as ClaudeAgentSession. */
  }

  sendUserMessage(text: string): void {
    void this.run(text).catch((err) => {
      this.emit("spawnError", err as Error);
      this.emit("exit", 1);
    });
  }

  closeInput(): void {
    /* no-op */
  }

  /** Abort the run — the sandbox sees the request close and kills the child. */
  stop(): void {
    try {
      this.controller.abort();
    } catch {
      /* best effort */
    }
  }

  private async run(prompt: string): Promise<void> {
    const res = await fetch(sandboxUrl("/query"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: this.controller.signal,
      body: JSON.stringify({
        workspaceKey: this.opts.workspaceKey,
        prompt,
        model: { id: this.opts.model.id },
        modelCreds: modelCreds(),
        allowedTools: this.opts.allowedTools,
        permissionMode: this.opts.permissionMode ?? "acceptEdits",
        resumeSessionId: this.opts.resumeSessionId,
        githubToken: this.opts.githubToken,
        repo: this.opts.repo,
        userId: this.opts.userId,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`sandbox query ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }

    // Parse SSE `data: {json}\n\n` frames: {t:"event",e} | {t:"exit",code} | {t:"error",message}.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let exited = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let frame: { t: string; e?: StreamJsonEvent; code?: number | null; message?: string };
        try {
          frame = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (frame.t === "event" && frame.e) this.emit("event", frame.e);
        else if (frame.t === "error") this.emit("spawnError", new Error(frame.message ?? "sandbox error"));
        else if (frame.t === "exit") {
          exited = true;
          this.emit("exit", frame.code ?? 0);
        }
      }
    }
    if (!exited) this.emit("exit", 0); // stream ended without an explicit exit frame
  }
}
