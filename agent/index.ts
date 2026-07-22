/**
 * Wiring / entrypoint (HTTP).
 *
 *   GET  /                         -> built-in AG-UI test client (public/index.html)
 *   POST /sessions {prompt,...}    -> {sessionId} (starts a new multi-turn session)
 *   POST /sessions/:id/messages    -> continue a session with a follow-up turn
 *   DELETE /sessions/:id           -> drop a session (log, workspace, resume map)
 *   GET  /sessions/:id/events      -> SSE AG-UI stream; honours Last-Event-ID
 *   GET  /auth/github/login        -> 302 to GitHub App authorize (?link=<t> connects a chat user)
 *   GET  /auth/github/callback     -> code exchange; stores the user's token
 *   GET  /auth/github/status       -> { connected, login, configured }
 *   GET  /api/whoami               -> { userId, email, admin, github... } (browser /whoami)
 *   GET  /api/setup/status         -> { configured, appSlug }
 *   GET  /api/setup/github/start   -> manifest auto-POST page (provision-gated)
 *   GET  /api/setup/github/callback-> manifest-code exchange; stores App creds; -> install flow
 *
 * GitHub App provisioning is web-driven: an authorized user clicks "Set up GitHub
 * App" in the UI, and the two routes above drive GitHub's App-Manifest flow to
 * create the App (auth/setup.ts). Who may provision is governed by canProvision:
 * admins (ADMIN_EMAILS, matched against the ALB-verified email), or — when no
 * admin list is set — any signed-in user for the initial setup only. Resolved
 * creds live in auth/app-config.ts (stored in the DB).
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
import { createWorkspace, removeWorkspace } from "./session/workspace.ts";
import { createTelemetry, type Telemetry } from "./telemetry/otel.ts";
import { startTelemetrySdk, shutdownTelemetrySdk } from "./telemetry/bootstrap.ts";
import { InMemoryResultStore, toRunRecord, type ResultStore } from "./persistence/results.ts";
import { resolveModel, describeAuth } from "./config/model.ts";
import { createStore, type Store } from "./store/index.ts";
import { authorizeUrl, exchangeCode, getValidToken } from "./auth/github-app.ts";
import { githubConfigured, getAppCreds, saveAppCreds, loadAppCreds } from "./auth/app-config.ts";
import { verifyState, buildManifest, convertManifestCode, renderManifestForm, isAdmin, adminListConfigured, canProvision } from "./auth/setup.ts";
import { getServerSecret, verifyLink } from "./auth/connect.ts";
import { Authorizer, oidcIdentity, oidcEmail, type AuthzResult } from "./auth/authz.ts";
import { SSE_HEADERS, frameLogged, sseHeartbeat, parseLastEventId } from "./transport/sse.ts";
import { EventType } from "./types/agui.ts";
import type { SystemInitEvent, StreamJsonEvent } from "./types/streamjson.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const registry = new SessionRegistry();
const resultStore: ResultStore = new InMemoryResultStore();
/** bridge session id -> Claude's session_id, resumed on each follow-up turn. */
const claudeSessionIds = new Map<string, string>();
/** bridge session id -> its workspace cwd, reused across turns. */
const workspaces = new Map<string, string>();
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

interface TurnOpts {
  prompt: string;
  allowedTools: string[];
  permissionMode: string;
  userKey: string; // bridge_uid, for GitHub token lookup
}

/**
 * Run ONE turn of a session: spawn a Claude Agent SDK query, resuming the
 * session's prior Claude session_id if it has one (follow-up turns), and fan its
 * events into the SAME bridge session log — so a whole multi-turn conversation
 * accumulates in one registry entry and streams over one SSE connection.
 */
async function runTurn(bridgeId: string, cwd: string, opts: TurnOpts): Promise<void> {
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
    cwd,
    // Resume the prior Claude session (if any) so follow-up turns keep context.
    resumeSessionId: claudeSessionIds.get(bridgeId),
  });

  source.on("event", (ev) => {
    if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
      claudeSessionIds.set(bridgeId, (ev as SystemInitEvent).session_id);
    }
    telemetry.onEvent(bridgeId, ev);
    for (const aguiEvent of translator.handle(ev)) registry.append(bridgeId, aguiEvent);
    if (ev.type === "result") {
      registry.setStatus(bridgeId, ev.is_error ? "errored" : "finished");
      const rec = toRunRecord(model.id, ev);
      void resultStore.save(rec);
      // Surface the turn's token usage + cost to the client as a replayable event
      // (the translator drops usage; RUN_FINISHED carries none). Logged in the
      // registry so switching back to a session restores the figures; the client
      // sums per-turn usage into a session total.
      registry.append(bridgeId, {
        type: EventType.CUSTOM,
        name: "claude.usage",
        value: {
          inputTokens: rec.usage?.input_tokens ?? 0,
          outputTokens: rec.usage?.output_tokens ?? 0,
          cacheReadTokens: rec.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: rec.usage?.cache_creation_input_tokens ?? 0,
          costUsd: rec.costUsd, // reported total_cost_usd, else computed from the pricing table
          costSource: rec.costSource,
        },
      });
      // One telemetry root span per turn: endSession deletes the ctx entry, so
      // the next turn's init event opens a fresh span under the same bridgeId.
      telemetry.endSession(bridgeId);
    }
  });
  source.on("exit", (code) => {
    if (registry.status(bridgeId) === "running") {
      registry.setStatus(bridgeId, code === 0 ? "finished" : "errored");
    }
  });
  source.on("spawnError", (err) => {
    console.error(`[agent] session ${bridgeId} turn failed: ${err.message}`);
    registry.setStatus(bridgeId, "errored");
  });

  source.start();
  source.sendUserMessage(opts.prompt);
  source.closeInput(); // one query() per turn; resume carries context to the next
}

/** Start a NEW multi-turn session: mint an id, create its workspace, run turn 1. */
async function startSession(opts: TurnOpts): Promise<string> {
  const bridgeId = `sess_${randomUUID()}`;
  registry.ensure(bridgeId);
  // Each session gets its own writable temp workspace as its cwd (the process
  // cwd is the read-only /app source tree). Reused across turns; kept, no
  // cleanup. See session/workspace.ts.
  const cwd = createWorkspace();
  workspaces.set(bridgeId, cwd);
  console.log(`[bridge] session ${bridgeId} workspace ${cwd}`);
  await runTurn(bridgeId, cwd, opts);
  return bridgeId;
}

/** Run a FOLLOW-UP turn on an existing session: same workspace, resumed context. */
async function continueSession(bridgeId: string, opts: TurnOpts): Promise<void> {
  // Reuse the session's workspace; recreate one only if it was somehow lost (the
  // registry entry still exists, so this is defensive) to avoid failing the turn.
  let cwd = workspaces.get(bridgeId);
  if (!cwd) {
    cwd = createWorkspace();
    workspaces.set(bridgeId, cwd);
  }
  await runTurn(bridgeId, cwd, opts);
}

/* ---------------- test hooks (AYDA_TEST_HOOKS=1 only) ---------------- */

/**
 * TEST-ONLY: build a *finished* session by running the recorded read→edit→report
 * stream-json fixture through the Translator into the registry — the same path
 * scripts/demo-translate.ts exercises. Lets e2e tests seed a replayable session
 * (for SSE resume / delete assertions) without a real model call or credential.
 * Reached only from POST /test/seed, which is gated on AYDA_TEST_HOOKS=1.
 */
function seedSession(): { sessionId: string; lastSeq: number } {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "read-edit-report.streamjson.jsonl");
  const bridgeId = `sess_seed_${randomUUID()}`;
  registry.ensure(bridgeId);
  const lines = readFileSync(fixture, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const translator = new Translator({ includeRawEvent: false });
  let lastSeq = 0;
  for (const line of lines) {
    for (const ev of translator.handle(JSON.parse(line) as StreamJsonEvent)) {
      lastSeq = registry.append(bridgeId, ev).seq;
    }
  }
  registry.setStatus(bridgeId, "finished");
  return { sessionId: bridgeId, lastSeq };
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

/**
 * Themed 401 for a request the grants table denies — matches the app's dark
 * theme (see public/index.html) so a blocked user gets a coherent "no access"
 * page instead of the app shell or a bare error string.
 */
function render401(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access denied · Ayda</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#272b34; --fg:#e6e8ec; --muted:#8b93a1; --accent:#6ea8fe; --err:#ff6b6b; }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { display:flex; align-items:center; justify-content:center; padding:24px;
    font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:radial-gradient(1200px 600px at 50% -10%, #151b28 0%, var(--bg) 60%); color:var(--fg); }
  .card { width:min(460px,100%); background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:36px 32px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .badge { width:64px; height:64px; margin:0 auto 20px; border-radius:16px; display:flex; align-items:center; justify-content:center;
    background:rgba(255,107,107,.10); border:1px solid rgba(255,107,107,.35); color:var(--err); }
  .code { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--err); margin:0 0 10px; }
  h1 { font-size:20px; margin:0 0 10px; font-weight:600; letter-spacing:.01em; }
  p.msg { margin:0 auto; max-width:36ch; color:var(--muted); }
  .hint { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
  .hint b { color:var(--fg); font-weight:600; }
</style>
</head><body>
  <main class="card">
    <div class="badge">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <p class="code">Access denied</p>
    <h1>You don't have access</h1>
    <p class="msg">Your account isn't authorized to use this agent. If you think this is a mistake, ask an administrator to grant you access.</p>
    <div class="hint">Access is controlled by the deployment's <b>grants</b>.</div>
  </main>
</body></html>`;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureUid(req, res); // establish client identity on first load
  // Gate the UI itself: a request the grants table denies never sees the app
  // shell — it gets the themed 401 instead. Local dev / anonymous-with-`anyone`
  // resolve as allowed, so they still load normally.
  const { allowed } = await resolveIdentity(req, res);
  if (!allowed) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }).end(render401());
    return;
  }
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
    // Browser-initiated connect (the frontend "Connect GitHub" button). The ALB
    // already authenticated the user, so resolve their platform identity and key
    // the token by it — the same key status/whoami/chat read (PR #1). No signed
    // link is needed here; the ALB is the gate. Falls back to the cookie in dev.
    const id = await resolveIdentity(req, res);
    if (!id.allowed) {
      res.writeHead(403).end("forbidden");
      return;
    }
    userKey = id.userKey;
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
    // Land back on the app frontend rather than a dead-end confirmation page. The
    // `github=connected` hint lets the UI flash a brief note; refreshGh() also
    // reflects the connected state in the github chip on load.
    res.writeHead(302, { Location: "/?github=connected" }).end();
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
      : "not connected (use Connect GitHub)";
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      allowed,
      userId, // resolved platform user id (null when anonymous / local dev)
      email: email || null,
      admin: isAdmin(email), // admin is keyed on the verified email (ADMIN_EMAILS)
      adminConfigured: adminListConfigured(), // whether an admin allowlist exists at all

      canSetup: canProvision(email, { allowed, configured: githubConfigured() }), // may provision the App now
      githubConfigured: githubConfigured(),
      githubConnected: Boolean(rec),
      githubLogin: rec?.githubLogin ?? null,
      github, // human-readable summary
    }),
  );
}

/* ---------------- GitHub App setup (App-Manifest) routes ---------------- */

/**
 * GET /api/setup/github/start?link=<t>[&org=<o>] — starts App provisioning.
 * Reached via the frontend "Set up GitHub App" button. Authorization is by
 * canProvision: admins (ADMIN_EMAILS) resolved from the ALB identity, or — when
 * no admin list is set — any authorized user for the initial setup. Either way
 * it needs the ALB-verified identity, so setup is web-only. Then renders a page
 * that POSTs the manifest to GitHub. No SETUP_TOKEN, no signed link.
 */
async function setupStart(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const { allowed, email } = await resolveIdentity(req, res);
  if (!allowed) {
    sendPage(res, 403, "Not authorized", "You must be signed in to set up the GitHub App.");
    return;
  }
  if (!canProvision(email, { allowed, configured: githubConfigured() })) {
    const msg = adminListConfigured()
      ? "Setting up the GitHub App requires an admin (ADMIN_EMAILS)."
      : "The GitHub App is already configured. Set ADMIN_EMAILS to allow re-provisioning.";
    sendPage(res, 403, "Not authorized", msg);
    return;
  }
  const secret = await getServerSecret(store);
  const org = url.searchParams.get("org") || undefined;
  const { manifest, manifestUrl } = buildManifest(secret, org);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderManifestForm(manifest, manifestUrl));
}

/**
 * GET /api/setup/github/callback — GitHub redirects here after the App is
 * created. The signed `state` proves the request follows a real start; we
 * exchange the code for the App's credentials, store them, and redirect the
 * admin straight into the install-based connect flow.
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
    // The App now exists and its creds are cached, so chain straight into the
    // install-based connect flow instead of dead-ending at a "return to chat"
    // page. /auth/github/login resolves the admin's ALB identity (setup is
    // web-only, so they're authenticated) and, with the slug now cached, redirects
    // to GitHub's App-installation repo picker — the admin installs + authorizes
    // in one continuous flow rather than manually running /connect-github.
    res.writeHead(302, { Location: "/auth/github/login" }).end();
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
      void serveStatic(req, res);
      return;
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
      void setupStart(req, url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/setup/github/callback") {
      void setupCallback(url, res);
      return;
    }

    // TEST-ONLY seed hook (inert unless AYDA_TEST_HOOKS=1); see seedSession().
    if (req.method === "POST" && url.pathname === "/test/seed") {
      if (process.env.AYDA_TEST_HOOKS !== "1") return void res.writeHead(404).end("not found");
      try {
        res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify(seedSession()));
      } catch (e) {
        res.writeHead(500).end(`seed failed: ${(e as Error).message}`);
      }
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

    const mMsg = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (req.method === "POST" && mMsg) {
      const bridgeId = decodeURIComponent(mMsg[1]);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            if (!registry.has(bridgeId)) return void res.writeHead(404).end("unknown session");
            const b = JSON.parse(body || "{}");
            if (!b.prompt) return void res.writeHead(400).end("prompt required");
            // One query() runs at a time per session — refuse overlapping turns.
            const st = registry.status(bridgeId);
            if (st === "running" || st === "starting") return void res.writeHead(409).end("session busy");
            const { allowed, userKey } = await resolveIdentity(req, res);
            if (!allowed) return void res.writeHead(403).end("forbidden");
            await continueSession(bridgeId, {
              prompt: b.prompt,
              allowedTools: b.allowedTools ?? ["Read", "Edit", "Bash", "Grep"],
              permissionMode: b.permissionMode ?? "acceptEdits",
              userKey,
            });
            // The follow-up turn streams over the session's already-open SSE.
            res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId: bridgeId }));
          } catch (e) {
            res.writeHead(400).end(`bad request: ${(e as Error).message}`);
          }
        })();
      });
      return;
    }

    const mDel = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "DELETE" && mDel) {
      void (async () => {
        // Authorize the same way the other session routes do.
        const { allowed } = await resolveIdentity(req, res);
        if (!allowed) return void res.writeHead(403).end("forbidden");
        const bridgeId = decodeURIComponent(mDel[1]);
        // Drop all server-side state for the session: the event log (detaches any
        // open SSE), the resume mapping, the telemetry span ctx, and the sandbox
        // workspace on disk.
        const existed = registry.delete(bridgeId);
        claudeSessionIds.delete(bridgeId);
        removeWorkspace(workspaces.get(bridgeId));
        workspaces.delete(bridgeId);
        telemetry.endSession(bridgeId);
        res.writeHead(existed ? 204 : 404).end();
      })();
      return;
    }

    const m = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && m) {
      // Prefer the browser's Last-Event-ID header over the URL query param. On an
      // automatic EventSource reconnect the URL is unchanged (it may still carry
      // the initial ?lastEventId=-1), but the browser sends Last-Event-ID with the
      // last delivered seq — honour that so a reconnect resumes from the gap
      // instead of re-replaying the whole log (which duplicated the client's
      // timeline on every reconnect). The query param is the first-connect cursor.
      const headerSeq = parseLastEventId(req.headers["last-event-id"]); // -1 if absent
      const q = url.searchParams.get("lastEventId");
      const querySeq = q != null ? Number.parseInt(q, 10) : -1;
      const lastSeq = headerSeq >= 0 ? headerSeq : querySeq;
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
