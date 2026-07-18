/**
 * Wiring / entrypoint (HTTP).
 *
 *   GET  /                         -> built-in AG-UI test client (public/index.html)
 *   POST /sessions {prompt,...}    -> {sessionId}
 *   GET  /sessions/:id/events      -> SSE AG-UI stream; honours Last-Event-ID
 *   GET  /auth/github/login        -> 302 to GitHub App authorize (?link=<t> connects a chat user)
 *   GET  /auth/github/callback     -> code exchange; stores the user's token
 *   GET  /auth/github/status       -> { connected, login, configured }
 *   GET  /api/whoami               -> { userId, email, admin, github... } (browser /whoami)
 *   GET  /api/setup/status         -> { configured, appSlug }
 *   GET  /api/setup/github/start   -> manifest auto-POST page (setup-link gated)
 *   GET  /api/setup/github/callback-> manifest-code exchange; stores App creds
 *
 * GitHub App provisioning is chat-driven: an admin (ADMIN_USER_IDS) runs
 * /setup-github in a DM, the adapter mints a signed setup link, and the two
 * routes above drive GitHub's App-Manifest flow to create the App (auth/setup.ts).
 * Resolved creds live in auth/app-config.ts (stored in the DB).
 *
 * GitHub auth: per-user GitHub App OAuth. Users connect via /connect-github in
 * chat (token keyed by the messaging userId) or the browser (keyed by a
 * `bridge_uid` cookie). Tokens live in the Store (Postgres), reused across
 * sessions/reconnects. On session start we resolve a valid token (refresh if
 * needed) and inject it as GH_TOKEN into the Claude child; a git credential
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
import { authorizeUrl, exchangeCode, getValidToken } from "./auth/github-app.ts";
import { githubConfigured, getAppCreds, saveAppCreds, loadAppCreds } from "./auth/app-config.ts";
import { verifyState, buildManifest, convertManifestCode, renderManifestForm, isAdmin } from "./auth/setup.ts";
import { getServerSecret, verifyLink } from "./auth/connect.ts";
import { Authorizer, oidcIdentity, oidcEmail, type AuthzResult } from "./auth/authz.ts";
import { SSE_HEADERS, frameLogged, sseHeartbeat, parseLastEventId } from "./transport/sse.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const registry = new SessionRegistry();
const resultStore: ResultStore = new InMemoryResultStore();
/** bridge session id -> Claude's session_id (for --resume). */
const claudeSessionIds = new Map<string, string>();
/** OAuth CSRF: state nonce -> user key (bridge_uid, or a messaging userId for
 * connect-link logins). TODO: TTL/GC. */
const pendingStates = new Map<string, string>();
let telemetry: Telemetry;
let store: Store;
/** Manual-authz client: resolves the platform user id the sidecar keys chat on. */
const authorizer = new Authorizer();

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

/**
 * Resolve the identity a browser request acts as, keyed the SAME way chat is.
 *
 * In a deployment the ALB injects `x-amzn-oidc-identity`; we run it through the
 * manual-authz endpoint and use the returned platform `user_id` — the exact key
 * the messaging sidecar uses (StreamOptions.userId). So a GitHub token connected
 * over chat is found here for the same person, and vice versa.
 *
 * Locally (no ASTRO_AUTHZ_TOKEN / no ALB headers) authorize() is a no-op allow
 * with no userId, and we fall back to the bridge_uid cookie so dev isn't blocked.
 * An authenticated-but-unresolved or anonymous request also falls back to the
 * cookie for its token-storage key. `allowed:false` means the grants table
 * denied this user — callers should refuse rather than fall back.
 */
async function resolveIdentity(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ allowed: boolean; userKey: string; userId: string | null; email: string }> {
  const identityId = oidcIdentity(req);
  const email = oidcEmail(req);
  let authz: AuthzResult;
  try {
    authz = await authorizer.authorize(identityId);
  } catch {
    // Fail closed, matching the sidecar: an authz error is a denial.
    return { allowed: false, userKey: "", userId: null, email };
  }
  if (!authz.allowed) return { allowed: false, userKey: "", userId: authz.userId ?? null, email };
  const userId = authz.userId ?? (identityId || null);
  // Prefer the resolved platform id; fall back to the cookie for local dev /
  // anonymous so those requests still have a stable per-browser token key.
  const userKey = userId ?? ensureUid(req, res);
  return { allowed: true, userKey, userId, email };
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

async function githubLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!githubConfigured()) {
    res.writeHead(503).end("GitHub App not configured");
    return;
  }
  // A `link` param carries a signed messaging userId (minted by the chat
  // adapter). When present, connect THAT identity instead of a browser
  // bridge_uid, so the token lands under the key the adapter resolves
  // (StreamOptions.userId). Otherwise fall back to the cookie identity.
  const link = url.searchParams.get("link");
  let userKey: string;
  if (link) {
    const bound = verifyLink(link, "connect", await getServerSecret(store));
    if (!bound) {
      res.writeHead(400).end("invalid or expired connect link");
      return;
    }
    userKey = bound;
  } else {
    userKey = ensureUid(req, res);
  }
  const state = randomUUID();
  pendingStates.set(state, userKey);
  // Route through the App INSTALLATION (repo picker + write grant), not the bare
  // OAuth authorize. With `request_oauth_on_install` on the App, installing also
  // authorizes, and GitHub redirects back to /auth/github/callback with `code`
  // (+ installation_id). Fall back to OAuth authorize only when we lack the App
  // slug (e.g. env-supplied creds) — that grants identity but no repo access.
  const slug = getAppCreds()?.slug;
  res.setHeader(
    "Location",
    slug
      ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
      : authorizeUrl(state),
  );
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
    const installationId = url.searchParams.get("installation_id");
    console.log(
      `[github] connected ${rec.githubLogin ?? "?"}${installationId ? ` (installation ${installationId})` : " — no installation_id; token has no repo access until the App is installed"}`,
    );
    sendPage(res, 200, "GitHub connected", `Signed in as ${rec.githubLogin ?? "your account"}. You can return to your chat.`);
  } catch (e) {
    console.error(`[github] code exchange failed: ${(e as Error).message}`);
    sendPage(res, 502, "Connection failed", "GitHub OAuth exchange failed. Please try /connect-github again.");
  }
}

/** Minimal HTML confirmation page — the browser lands here after an OAuth or
 *  manifest round-trip, then the user returns to chat. */
function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${body}</p></body></html>`,
  );
}

async function githubStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Key the lookup by the resolved platform identity (same as chat), falling
  // back to the bridge_uid cookie for local dev / anonymous browsers.
  const { userKey } = await resolveIdentity(req, res);
  const rec = userKey ? await store.getGithubToken(userKey) : null;
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({ configured: githubConfigured(), connected: Boolean(rec), login: rec?.githubLogin ?? null }),
  );
}

/**
 * GET /api/whoami — the browser counterpart to the chat `/whoami` directive.
 * Reports the caller's resolved identity and GitHub connection state so the
 * frontend can render the same info the messaging adapter replies with.
 */
async function whoami(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { allowed, userKey, userId, email } = await resolveIdentity(req, res);
  const rec = allowed && githubConfigured() && userKey ? await store.getGithubToken(userKey) : null;
  const github = !githubConfigured()
    ? "not set up on this agent"
    : rec
      ? `connected as ${rec.githubLogin ?? "your account"}`
      : "not connected (run /connect-github in chat)";
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      allowed,
      userId, // resolved platform user id (null when anonymous / local dev)
      email: email || null,
      admin: userId ? isAdmin(userId) : false,
      githubConfigured: githubConfigured(),
      githubConnected: Boolean(rec),
      githubLogin: rec?.githubLogin ?? null,
      github, // human-readable summary, mirrors the chat /whoami line
    }),
  );
}

/* ---------------- GitHub App setup (App-Manifest) routes ---------------- */

/**
 * GET /api/setup/github/start?link=<t>[&org=<o>] — the admin lands here from
 * the setup link the chat adapter minted (after its isAdmin check). The signed,
 * kind-bound link is the sole gate on this endpoint; we then render a page that
 * POSTs the manifest to GitHub. No SETUP_TOKEN — authorization already happened
 * in chat.
 */
async function setupStart(url: URL, res: ServerResponse): Promise<void> {
  const secret = await getServerSecret(store);
  if (!verifyLink(url.searchParams.get("link"), "setup", secret)) {
    sendPage(res, 400, "Invalid setup link", "This setup link is invalid or expired. Run /setup-github again to get a fresh one.");
    return;
  }
  const org = url.searchParams.get("org") || undefined;
  const { manifest, manifestUrl } = buildManifest(secret, org);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderManifestForm(manifest, manifestUrl));
}

/**
 * GET /api/setup/github/callback — GitHub redirects here after the App is
 * created. The signed `state` proves the request follows a real start; we
 * exchange the code for the App's credentials and store them.
 */
async function setupCallback(url: URL, res: ServerResponse): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !verifyState(state, await getServerSecret(store))) {
    sendPage(res, 400, "Invalid setup callback", "This request is invalid or expired. Run /setup-github again.");
    return;
  }
  try {
    const creds = await convertManifestCode(code);
    await saveAppCreds(store, creds);
    console.log(`[setup] GitHub App '${creds.slug ?? "?"}' provisioned; OAuth is now configured`);
    sendPage(res, 200, "GitHub App created", "Setup is done. Return to your chat and run /connect-github to connect your account.");
  } catch (e) {
    console.error(`[setup] manifest conversion failed: ${(e as Error).message}`);
    sendPage(res, 502, "Setup failed", "The GitHub App could not be created. Check the logs and run /setup-github again.");
  }
}

/* ---------------- messaging (web / Slack via the sidecar) ---------------- */

/**
 * Register a Claude Code AgentAdapter with the platform's messaging sidecar so
 * users can converse over Slack / web chat. The sidecar injects GRPC_SERVER_ADDR
 * only when `agent.interfaces.messaging: true` is deployed; outside that (local
 * `node agent/index.ts`, or a frontend-only deploy) there is nothing to bind to,
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
  await loadAppCreds(store);
  await getServerSecret(store); // stable HMAC secret for messaging connect links
  console.log(`[bridge] ${describeAuth()}`);
  console.log(
    `[bridge] github: ${
      githubConfigured()
        ? `GitHub App OAuth configured${getAppCreds()?.slug ? ` (${getAppCreds()!.slug})` : ""}`
        : "not configured — an admin can provision it from chat with /setup-github"
    }`,
  );
  await startMessaging();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveStatic(req, res);
    }
    if (req.method === "GET" && url.pathname === "/auth/github/login") {
      void githubLogin(req, res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/github/callback") {
      void githubCallback(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/github/status") {
      void githubStatus(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/whoami") {
      void whoami(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/setup/status") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          configured: githubConfigured(),
          appSlug: getAppCreds()?.slug ?? null,
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/setup/github/start") {
      void setupStart(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/setup/github/callback") {
      void setupCallback(url, res);
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
            // Resolve + authorize the caller the same way the sidecar does; the
            // GitHub token is keyed by the resolved platform id so git/gh act as
            // the same identity the user connected in chat.
            const { allowed, userKey } = await resolveIdentity(req, res);
            if (!allowed) return void res.writeHead(403).end("forbidden");
            const sessionId = await startSession({
              prompt: b.prompt,
              allowedTools: b.allowedTools ?? ["Read", "Edit", "Bash", "Grep"],
              permissionMode: b.permissionMode ?? "acceptEdits",
              userKey,
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
