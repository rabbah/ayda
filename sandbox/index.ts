/**
 * Execution sandbox — isolated Claude Code runner (the cruise-line pattern).
 *
 * This container has NO access to the control plane's database, GitHub tokens,
 * HMAC signing secret, App client secret, or other users' data. It receives per
 * request only what a single run needs: the (deploy-constant) model credential,
 * one user's GH_TOKEN, and the repo to work on. So a rogue `bash` the model runs
 * can touch at most this thread's checkout — not the platform's secrets.
 *
 * The control plane (agent/) calls this over HTTP; SandboxSession
 * (agent/sandbox-client.ts) is the typed client. We stream RAW stream-json events
 * over SSE and let the control plane keep the Translator / telemetry / usage.
 *
 * Endpoints:
 *   GET  /health
 *   POST /ensure-repo  {workspaceKey, owner, repo, githubToken?}   -> {dir, cloned}
 *   POST /query        {workspaceKey, prompt, model, modelCreds,   -> SSE frames
 *                       allowedTools, permissionMode, resumeSessionId?, githubToken?, repo?}
 *   POST /cleanup      {workspaceKey}                              -> {ok}
 *
 * WORKSPACE_ROOT is set in the Dockerfile so it matches session/workspace.ts's
 * root (the GC sweeps the same dir). One workspace dir per conversation key,
 * reused across turns.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAgentSession } from "../agent/claude/agent.ts";
import { ensureRepo, type RepoSpec } from "../agent/session/repo.ts";
import { startWorkspaceGc } from "../agent/session/workspace.ts";
import { Semaphore } from "../agent/concurrency.ts";
import type { ResolvedModel } from "../agent/config/model.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.env.WORKSPACE_ROOT ?? "/data/workspaces";
// Cap concurrent `claude` children in THIS sandbox so it can't exhaust its
// (non-bumpable) container memory. This is a backstop beyond the agent's
// per-process runLimiter — it also bounds load when several agent replicas call
// one shared sandbox. Lower SANDBOX_MAX_CONCURRENT if the container is tight.
const sandboxLimiter = new Semaphore(Number(process.env.SANDBOX_MAX_CONCURRENT ?? "3"));

/** Deterministic per-conversation workspace dir (reused across turns). */
function workspaceFor(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "default";
  const dir = join(ROOT, `ada-${safe}`); // `ada-` prefix so the GC sweep recognizes it
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Apply forwarded model creds to the process env (deploy-constant, so idempotent
 * and safe under concurrency). The per-USER secret (GH_TOKEN) is NOT set here — it
 * rides per-request into the child via ClaudeAgentSession's githubToken option.
 */
function applyModelCreds(creds: Record<string, string> | undefined): void {
  if (!creds) return;
  for (const [k, v] of Object.entries(creds)) if (v && !process.env[k]) process.env[k] = v;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handleEnsureRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readBody(req);
  const workspaceKey = String(b.workspaceKey ?? "");
  const owner = String(b.owner ?? "");
  const repo = String(b.repo ?? "");
  if (!workspaceKey || !owner || !repo) return json(res, 400, { error: "workspaceKey, owner, repo required" });
  try {
    const ws = workspaceFor(workspaceKey);
    const r = await ensureRepo(ws, { owner, repo }, { githubToken: b.githubToken as string | undefined });
    json(res, 200, r);
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}

async function handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readBody(req);
  const workspaceKey = String(b.workspaceKey ?? "");
  const prompt = String(b.prompt ?? "");
  const modelId = (b.model as { id?: string })?.id;
  if (!workspaceKey || !prompt || !modelId) return json(res, 400, { error: "workspaceKey, prompt, model.id required" });

  applyModelCreds(b.modelCreds as Record<string, string> | undefined);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

  // Heartbeat: keep the SSE body active during long, QUIET operations (a
  // multi-minute build/clone with no model output). Without periodic bytes the
  // control plane's fetch trips undici's idle bodyTimeout (~5m) and kills the
  // turn mid-build (the reported "terminated: Body Timeout Error"). The client
  // ignores heartbeat frames (SandboxSession only handles event/error/exit).
  const heartbeat = setInterval(() => {
    try {
      send({ t: "heartbeat" });
    } catch {
      /* socket closing */
    }
  }, 15_000);
  heartbeat.unref?.();

  // Headers are already sent, so the client holds the connection open while we
  // wait for a concurrency slot; every exit path goes through end() to release it.
  let ended = false;
  let acquired = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    if (acquired) sandboxLimiter.release();
    res.end();
  };
  await sandboxLimiter.acquire();
  acquired = true;

  const ws = workspaceFor(workspaceKey);
  let cwd = ws;
  const repo = b.repo as RepoSpec | undefined;
  if (repo?.owner && repo?.repo) {
    try {
      cwd = (await ensureRepo(ws, repo, { githubToken: b.githubToken as string | undefined })).dir;
    } catch (e) {
      send({ t: "error", message: `checkout failed: ${(e as Error).message}` });
      send({ t: "exit", code: 1 });
      end();
      return;
    }
  }

  const model: ResolvedModel = { id: modelId, provider: (b.model as { provider?: string })?.provider ?? "anthropic" };
  const source = new ClaudeAgentSession({
    model,
    allowedTools: (b.allowedTools as string[]) ?? ["Read", "Edit", "Bash", "Grep"],
    permissionMode: (b.permissionMode as string) ?? "acceptEdits",
    resumeSessionId: b.resumeSessionId as string | undefined,
    githubToken: b.githubToken as string | undefined,
    systemPromptAppend: b.systemPromptAppend as string | undefined,
    cwd,
    // Forwarded from the control plane so the run's trace is attributed to the
    // end user (ClaudeAgentSession.withUserTrace tags langfuse.user.id).
    userId: b.userId as string | undefined,
  });

  source.on("event", (ev) => send({ t: "event", e: ev }));
  source.on("spawnError", (err) => send({ t: "error", message: err.message }));
  source.on("exit", (code) => {
    send({ t: "exit", code });
    end();
  });
  // Client disconnected (control plane aborted — a superseded/stopped turn): kill
  // the child so it doesn't keep running in the workspace.
  req.on("close", () => {
    try {
      source.stop();
    } catch {
      /* best effort */
    }
    end();
  });

  source.start();
  source.sendUserMessage(prompt);
  source.closeInput();
}

async function handleCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readBody(req);
  const workspaceKey = String(b.workspaceKey ?? "");
  if (!workspaceKey) return json(res, 400, { error: "workspaceKey required" });
  const safe = workspaceKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "default";
  rmSync(join(ROOT, `ada-${safe}`), { recursive: true, force: true });
  json(res, 200, { ok: true });
}

function main(): void {
  mkdirSync(ROOT, { recursive: true });
  startWorkspaceGc(); // reclaim idle per-thread checkouts on this volume

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/ensure-repo") return void handleEnsureRepo(req, res);
    if (req.method === "POST" && url.pathname === "/query") return void handleQuery(req, res);
    if (req.method === "POST" && url.pathname === "/cleanup") return void handleCleanup(req, res);
    json(res, 404, { error: "not found" });
  });
  // A /query is a long-lived SSE response (a build can run many minutes). Disable
  // the server's request timeout so Node doesn't cut the connection from its end;
  // the heartbeat + the control plane's abort handle liveness instead.
  server.requestTimeout = 0;
  server.listen(PORT, () => console.log(`[sandbox] listening on :${PORT}, workspaces at ${ROOT}`));
}

main();
