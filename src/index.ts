/**
 * Wiring / entrypoint (HTTP).
 *
 *   GET  /                         -> built-in AG-UI test client (public/index.html)
 *   POST /sessions {prompt,...}    -> {sessionId}
 *   GET  /sessions/:id/events      -> SSE AG-UI stream; honours Last-Event-ID
 *   GET  /auth/github/login        -> 302 to GitHub App authorize
 *   GET  /auth/github/callback     -> code exchange; stores the user's token
 *   GET  /auth/github/status       -> { connected, login, configured }
 *
 * GitHub auth: per-user GitHub App OAuth. A `bridge_uid` cookie is the stable
 * client identity; the user's token lives in the Store (Postgres), reused across
 * their sessions/reconnects. On session start we resolve a valid token (refresh
 * if needed) and inject it as GH_TOKEN into the Claude child; a git credential
 * helper baked into the image makes git/gh use it. No static PAT.
 *
 * SCAFFOLD skeleton — CSRF-state GC, cookie signing, token encryption-at-rest,
 * backpressure, session GC, follow-up turns, and MQ transport are marked TODO.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClaudeAgentSession } from "./claude/agent.ts";
import { Translator } from "./translate/translator.ts";
import { SessionRegistry } from "./session/registry.ts";
import { createTelemetry, type Telemetry } from "./telemetry/otel.ts";
import { startTelemetrySdk, shutdownTelemetrySdk } from "./telemetry/bootstrap.ts";
import { InMemoryResultStore, toRunRecord, type ResultStore } from "./persistence/results.ts";
import { resolveModel, describeAuth } from "./config/model.ts";
import { createStore, type Store } from "./store/index.ts";
import { authorizeUrl, exchangeCode, getValidToken, githubConfigured } from "./auth/github-app.ts";
import { SSE_HEADERS, frameLogged, sseHeartbeat, parseLastEventId } from "./transport/sse.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const registry = new SessionRegistry();
const resultStore: ResultStore = new InMemoryResultStore();
/** bridge session id -> Claude's session_id (for --resume). */
const claudeSessionIds = new Map<string, string>();
/** OAuth CSRF: state nonce -> bridge_uid. TODO: TTL/GC. */
const pendingStates = new Map<string, string>();
let telemetry: Telemetry;
let store: Store;

/* ---------------- cookies / client identity ---------------- */

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Return the stable client id, minting + setting the cookie if absent. */
function ensureUid(req: IncomingMessage, res: ServerResponse): string {
  const existing = readCookie(req, "bridge_uid");
  if (existing) return existing;
  const uid = randomUUID();
  // TODO: sign the cookie so a client can't spoof another user's identity.
  res.setHeader("Set-Cookie", `bridge_uid=${uid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
  return uid;
}

/* ---------------- session bridging ---------------- */

interface StartOpts {
  prompt: string;
  allowedTools: string[];
  permissionMode: string;
  userKey: string; // bridge_uid, for GitHub token lookup
}

async function startSession(opts: StartOpts): Promise<string> {
  const bridgeId = `sess_${randomUUID()}`;
  registry.ensure(bridgeId);
  registry.setStatus(bridgeId, "running");

  const model = resolveModel();
  // Resolve a valid GitHub token for this user (refresh if expiring); undefined
  // if GitHub isn't configured or the user hasn't connected.
  const githubToken = githubConfigured()
    ? ((await getValidToken(store, opts.userKey)) ?? undefined)
    : undefined;

  const translator = new Translator();
  const source = new ClaudeAgentSession({
    model,
    allowedTools: opts.allowedTools,
    permissionMode: opts.permissionMode,
    githubToken,
  });

  source.on("event", (ev) => {
    if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
      claudeSessionIds.set(bridgeId, ev.session_id);
    }
    telemetry.onEvent(bridgeId, ev);
    for (const aguiEvent of translator.handle(ev)) registry.append(bridgeId, aguiEvent);
    if (ev.type === "result") {
      registry.setStatus(bridgeId, ev.is_error ? "errored" : "finished");
      void resultStore.save(toRunRecord(model.id, ev));
      telemetry.endSession(bridgeId);
    }
  });
  source.on("exit", (code) => {
    if (registry.status(bridgeId) === "running") {
      registry.setStatus(bridgeId, code === 0 ? "finished" : "errored");
    }
  });
  source.on("spawnError", (err) => {
    console.error(`[agent] session failed: ${err.message}`);
    registry.setStatus(bridgeId, "errored");
  });

  source.start();
  source.sendUserMessage(opts.prompt);
  source.closeInput(); // single-turn scaffold
  return bridgeId;
}

/* ---------------- SSE ---------------- */

function streamEvents(sessionId: string, lastSeq: number, req: IncomingMessage, res: ServerResponse): void {
  if (!registry.has(sessionId)) {
    res.writeHead(404).end("unknown session");
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  const seen = new Set<number>();
  for (const logged of registry.since(sessionId, lastSeq)) {
    seen.add(logged.seq);
    res.write(frameLogged(logged));
  }
  const unsubscribe = registry.subscribe(sessionId, (logged) => {
    if (seen.has(logged.seq)) return;
    seen.add(logged.seq);
    res.write(frameLogged(logged));
  });
  const heartbeat = setInterval(() => res.write(sseHeartbeat()), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  ensureUid(req, res); // establish client identity on first load
  try {
    const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  } catch {
    res.writeHead(404).end("client not found");
  }
}

/* ---------------- GitHub OAuth routes ---------------- */

function githubLogin(req: IncomingMessage, res: ServerResponse): void {
  if (!githubConfigured()) {
    res.writeHead(503).end("GitHub App not configured");
    return;
  }
  const uid = ensureUid(req, res);
  const state = randomUUID();
  pendingStates.set(state, uid);
  res.setHeader("Location", authorizeUrl(state));
  res.writeHead(302).end();
}

async function githubCallback(url: URL, res: ServerResponse): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const uid = state ? pendingStates.get(state) : undefined;
  if (state) pendingStates.delete(state);
  if (!code || !uid) {
    res.writeHead(400).end("invalid OAuth callback");
    return;
  }
  try {
    const rec = await exchangeCode(code);
    await store.putGithubToken(uid, rec);
    res.setHeader("Location", "/?github=connected");
    res.writeHead(302).end();
  } catch (e) {
    console.error(`[github] code exchange failed: ${(e as Error).message}`);
    res.writeHead(502).end("GitHub OAuth exchange failed");
  }
}

async function githubStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uid = readCookie(req, "bridge_uid");
  const rec = uid ? await store.getGithubToken(uid) : null;
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({ configured: githubConfigured(), connected: Boolean(rec), login: rec?.githubLogin ?? null }),
  );
}

/* ---------------- messaging (web / Slack via the sidecar) ---------------- */

/**
 * Register a Claude Code AgentAdapter with the platform's messaging sidecar so
 * users can converse over Slack / web chat. The sidecar injects GRPC_SERVER_ADDR
 * only when `agent.interfaces.messaging: true` is deployed; outside that (local
 * `node src/index.ts`, or a frontend-only deploy) there is nothing to bind to,
 * so this is a no-op. `@astropods/adapter-core` and the adapter are imported
 * dynamically so the process runs without the package present.
 */
async function startMessaging(): Promise<void> {
  if (!process.env.GRPC_SERVER_ADDR) {
    console.log("[bridge] messaging: no GRPC_SERVER_ADDR — sidecar not attached, Slack/web chat off");
    return;
  }
  try {
    const { serve } = (await import("@astropods/adapter-core")) as {
      serve: (adapter: unknown, options?: unknown) => void;
    };
    const { ClaudeCodeAdapter } = await import("./messaging/adapter.ts");
    serve(new ClaudeCodeAdapter(store));
    console.log("[bridge] messaging: registered Claude Code adapter with sidecar (web/slack)");
  } catch (e) {
    console.warn(`[bridge] messaging: adapter not started: ${(e as Error).message}`);
  }
}

/* ---------------- server ---------------- */

async function main(): Promise<void> {
  await startTelemetrySdk();
  telemetry = await createTelemetry();
  store = await createStore();
  console.log(`[bridge] ${describeAuth()}`);
  console.log(`[bridge] github: ${githubConfigured() ? "GitHub App OAuth configured" : "not configured (set GITHUB_APP_CLIENT_ID/SECRET)"}`);
  await startMessaging();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveStatic(req, res);
    }
    if (req.method === "GET" && url.pathname === "/auth/github/login") {
      return githubLogin(req, res);
    }
    if (req.method === "GET" && url.pathname === "/auth/github/callback") {
      void githubCallback(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/github/status") {
      void githubStatus(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            const b = JSON.parse(body || "{}");
            if (!b.prompt) return void res.writeHead(400).end("prompt required");
            const uid = ensureUid(req, res);
            const sessionId = await startSession({
              prompt: b.prompt,
              allowedTools: b.allowedTools ?? ["Read", "Edit", "Bash", "Grep"],
              permissionMode: b.permissionMode ?? "acceptEdits",
              userKey: uid,
            });
            res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId }));
          } catch (e) {
            res.writeHead(400).end(`bad request: ${(e as Error).message}`);
          }
        })();
      });
      return;
    }

    const m = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && m) {
      const q = url.searchParams.get("lastEventId");
      const lastSeq = q != null ? Number.parseInt(q, 10) : parseLastEventId(req.headers["last-event-id"]);
      return streamEvents(decodeURIComponent(m[1]), Number.isFinite(lastSeq) ? lastSeq : -1, req, res);
    }

    res.writeHead(404).end("not found");
  });

  server.listen(PORT, () => {
    console.log(`[bridge] listening on http://localhost:${PORT}`);
    console.log(`[bridge] open the test client at http://localhost:${PORT}/`);
  });

  const shutdown = async () => {
    server.close();
    await shutdownTelemetrySdk();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
