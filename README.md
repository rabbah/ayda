# Ayda

**Ayda** is a coding agent powered by Claude Code. It runs a Claude Code session
headlessly inside a container and re-emits its output as **AG-UI** events over
**SSE**, so any AG-UI-compatible frontend (CopilotKit, custom dashboards) can
consume it directly. You converse with it over **Slack / web chat** (the Astro
messaging sidecar) or the built-in AG-UI frontend. It's an Astropods/K8s
workload: a wrapper process that drives a Claude Agent SDK session and exposes it
over a clean event API.

> **Why the name?** Named for **Ada Lovelace** (1815–1852), who wrote the first
> algorithm intended to be carried out by a machine and is widely regarded as the
> first computer programmer — a fitting namesake for an agent that writes and runs
> code for you. The Astropods blueprint deploys as **`ayda`** (a phonetic spelling
> of "Ada") because `ada` isn't a valid blueprint name.

> Status: **usable, with SCAFFOLD edges.** Multi-turn sessions, per-session
> sandbox workspaces, GitHub per-user OAuth, the Astro AI Gateway path, and
> Slack/web messaging are all real. Durability/GC of the in-memory session
> registry, workspace cleanup, cookie signing, and token encryption-at-rest are
> still `TODO` (grep the source).

## Run the demo (no API key, no network, no frontend)

Node ≥ 23 runs the TypeScript sources directly (type-stripping). The demo needs
no dependencies.

```bash
npm run demo         # AG-UI event list + sample SSE frames + cost summary
npm run demo:sse     # raw SSE frames only
# (or: node scripts/demo-translate.ts [--sse])
```

It feeds `fixtures/read-edit-report.streamjson.jsonl` (a recorded Claude Code
`read → edit → report` run) through the translator and prints the AG-UI
payloads. This validates the mapping logic only — it does not spawn anything.
See "AG-UI output" below for the produced sequence.

## Run live locally (real Claude Agent SDK + built-in test client)

Prerequisites on your machine: the `claude` CLI on `PATH` (the SDK spawns it),
and a model credential. Locally the simplest is a personal key, which routes
directly to Anthropic (bypassing the gateway):

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # never logged; only passed to the child
node agent/index.ts                        # -> http://localhost:8080
```

Open `http://localhost:8080/`, type a prompt (e.g. "read package.json and tell
me the version"), and watch the AG-UI stream render as chat. Keep replying to
continue the same session — follow-up turns resume the prior context in the same
workspace. The UI shows a per-session token/cost readout, a session-history
switcher (**＋ New session**), and a gear **Settings** panel (identity + GitHub
connect/setup).

**Debug inspector (`?debug`):** the built-in client is a clean single-column
chat by default. Append **`?debug`** (`http://localhost:8080/?debug`) to reveal
a right-hand panel with the raw AG-UI events and their sequence numbers, plus
**Disconnect** / **Reconnect (replay)** buttons that demonstrate lossless
catch-up via `Last-Event-ID`. Dev/inspection tool only — hidden by default,
never part of an end-user UI. (The built-in client is itself a test harness;
real frontends like CopilotKit consume the same SSE stream.)

The client is a single dependency-free file (`public/index.html`) served
same-origin (no CORS, no build). Each session runs in its own writable temp
workspace (see `agent/session/workspace.ts`), not the process CWD.

## HTTP API

The built-in client and any external AG-UI client drive the same pipeline:

| Route | Purpose |
|---|---|
| `GET  /` | Built-in AG-UI test client (`public/index.html`) |
| `POST /sessions` `{prompt, allowedTools?, permissionMode?}` | Start a session → `{sessionId}` |
| `POST /sessions/:id/messages` `{prompt}` | Continue a session with a follow-up turn |
| `GET  /sessions/:id/events` | SSE AG-UI stream; honours `Last-Event-ID` replay |
| `GET  /api/whoami` | Resolved identity + admin + GitHub connection state |
| `GET  /auth/github/login` · `/callback` · `/status` | Per-user GitHub App OAuth |
| `GET  /api/setup/github/start` · `/callback` · `/api/setup/status` | Web-driven GitHub App provisioning |

Only one turn runs at a time per session — an overlapping `POST .../messages`
returns `409 busy`. When a deployment gates access, an unauthorized request gets
a themed `401` instead of the app shell.

## Run on the Astro platform (container, cloud)

The agent is packaged for Astropods (`astropods.yml` + `Dockerfile` + `AGENT.md`).
Claude Code runs **inside the container** — the image bakes in the `claude` CLI
(plus `git` + `gh`).

```bash
ast project start        # build + run the container locally (frontend on :80)
# then deploy via your platform flow (see `ast docs`)
```

Key facts:
- **`agent.interfaces.frontend: true`** → the container listens on **port 80**
  (`Dockerfile` sets `PORT=80`; runs as root to bind it). The built-in AG-UI
  client + SSE API are served there and exposed at `ASTRO_EXTERNAL_AGENT_URL`.
- **`agent.interfaces.messaging: true`** → the platform's messaging sidecar
  (web chat / Slack) is deployed. It normalizes each inbound message and streams
  it over gRPC (`GRPC_SERVER_ADDR`); `agent/messaging/adapter.ts` (a Claude Code
  `AgentAdapter`) runs our side, so a Slack thread becomes one continuous Claude
  conversation. **No Slack tokens needed** — Slack is platform-managed.
- **`astro_ai_gateway: true`** → model calls route through the Astro AI Gateway
  (injects `ASTRO_GATEWAY_URL` + `ASTRO_GATEWAY_API_KEY`); no personal key baked
  in. See "Model routing & auth" below. Opt out per-deploy with the optional
  `ANTHROPIC_API_KEY` input (talks to Anthropic directly).
- **`knowledge.db: postgres`** → platform-managed Postgres (`POSTGRES_*`) stores
  per-user GitHub OAuth tokens, the GitHub App creds, and the server HMAC secret.
- **`ADMIN_EMAILS`** (optional input) → comma-separated admin emails allowed to
  provision the GitHub App from the web UI (matched against the ALB-verified
  identity). Unset ⇒ any signed-in user may do the *initial* setup, then it locks.
- The `claude` CLI version is a **build arg** (`CLAUDE_CODE_VERSION`, default
  `latest`) — **pin it** in production (see Pin list #1).

`dev.command` (`node --watch agent/index.ts`) is the `ast dev` hot-reload path:
the container bind-mounts `agent/` so host edits reload live (this is why the
source lives in `agent/`). Local `ast dev` adapters are `[web, slack]`.

## Tests

End-to-end tests (Playwright) cover the SSE reconnect fix and session delete — no
model credential needed. The server boots on Node alone (every external dep is
dynamically imported and guarded), and a test-only `POST /test/seed` hook builds a
replayable session from the recorded fixture, so the transport/registry behaviour
is exercised without a real Claude run.

```bash
npm install                                   # brings in @playwright/test
npx playwright install --with-deps chromium   # one-time browser download
npm test                                       # or: npm run test:ui
```

- `test/server-sse.spec.ts` — the server prefers the `Last-Event-ID` header over a
  stale `?lastEventId=-1` query (reconnect *resumes*, not full-replays), plus
  `DELETE /sessions/:id` semantics (204 → 404; events 404 afterward).
- `test/client-reconnect.spec.ts` — mocks the SSE endpoint to force repeated
  full-buffer replays and asserts the client renders `✓ finished` exactly once
  (the reconnect-dedupe fix).
- `test/client-delete.spec.ts` — the ✕ in the session menu issues `DELETE
  /sessions/:id` and removes the row.

`POST /test/seed` is exposed ONLY when `AYDA_TEST_HOOKS=1` (set by
`playwright.config.ts`'s `webServer`); it's inert in production. CI runs the suite
on every push to `main` and every PR (`.github/workflows/e2e.yml`).

## Architecture

One internal pipeline, three sinks. The parsed stream-json event stream is the
single source of truth; the translator, telemetry, and persistence each
subscribe independently, so what the client sees can't drift from what's billed.
The same pipeline feeds both the SSE/AG-UI frontend and the messaging sidecar.

```
 HTTP (POST /sessions) ─┐
 Slack / web (sidecar) ─┴─▶ per-session sandbox workspace (cwd)
                                    │
                                    ▼
 ClaudeAgentSession ──▶ Claude Agent SDK query() ──spawns──▶ `claude` (stream-json)
        │  emits parsed stream-json / SDK-message events
        ├──────────────▶ Translator ──▶ SessionRegistry (per-session AG-UI log, seq'd)
        │                                        │
        │                                        └──▶ SSE emitter (Last-Event-ID replay)
        ├──────────────▶ Telemetry (OTel spans/metrics; cost → $)
        └──────────────▶ ResultStore (final result persisted for billing)
```

| Module | Responsibility |
|---|---|
| `agent/config/model.ts` | **Isolated swap seam.** Model resolution, the **sandboxed spawn env** (allowlist only; host secrets dropped), gateway-vs-direct routing, pricing table + cost. |
| `agent/claude/agent.ts` | **Default source.** Runs the Claude Agent SDK `query()` with the `claude_code` preset via `@astropods/adapter-claude-agent-sdk` (OTel-instrumented); yields typed messages (same envelopes as stream-json) → same Translator. Spawns the `claude` binary, so it must be in the image. |
| `agent/claude/supervisor.ts` | Alternative source: spawns `claude -p` directly and parses NDJSON. Kept as a fallback; same event interface as the SDK source. |
| `agent/translate/translator.ts` | Pure stream-json/SDK-message → AG-UI mapping. Stateful per run. |
| `agent/session/registry.ts` | Per-session AG-UI event log with monotonic seq → lossless reconnect. Decoupled from transport. Accumulates all turns of a session. |
| `agent/session/workspace.ts` | Per-session writable temp workspace (the child's cwd), reused across turns. |
| `agent/messaging/adapter.ts` | Claude Code `AgentAdapter` for the Astro messaging sidecar (web/Slack); maps AG-UI events onto the sidecar hooks and resumes threads. |
| `agent/auth/*` | Per-user GitHub App OAuth (`github-app`, `app-config`), web-driven App-Manifest provisioning (`setup`), signed chat connect links (`connect`), and ALB-identity resolution (`authz`). |
| `agent/store/*` | Postgres-backed store (GitHub tokens, App creds, server secret); in-memory fallback. |
| `agent/transport/sse.ts` | AG-UI SSE framing + `Last-Event-ID` replay. |
| `agent/telemetry/*` | OTel GenAI-semconv traces + metrics; cost. No-op without `@opentelemetry/api`. |
| `agent/persistence/results.ts` | Persist final `result` (cost, usage, turns) for billing/observability. |
| `agent/index.ts` | HTTP wiring, session lifecycle, GitHub/auth routes, messaging bootstrap. |

## stream-json → AG-UI mapping

| Claude Code stream-json | AG-UI event(s) |
|---|---|
| `system` / `init` | `RUN_STARTED` (threadId = session_id) + `STATE_SNAPSHOT` (model, cwd, tools, capabilities) |
| `system` / `api_retry` | `CUSTOM` `name: "claude.api_retry"` (no native AG-UI event) |
| `stream_event` `content_block_start` (text) | `TEXT_MESSAGE_START` |
| `stream_event` `content_block_delta` (`text_delta`) | `TEXT_MESSAGE_CONTENT` (`delta`) |
| `stream_event` `content_block_start` (tool_use) | `TOOL_CALL_START` (`toolCallId`, `toolCallName`) |
| `stream_event` `content_block_delta` (`input_json_delta`) | `TOOL_CALL_ARGS` (`delta` = `partial_json`, 1:1) |
| `stream_event` `content_block_stop` | `TEXT_MESSAGE_END` / `TOOL_CALL_END` (per open block) |
| `assistant` (complete) | fallback full triples **iff** not already streamed; else usage-only |
| `user` (tool_result block) | `TOOL_CALL_RESULT` (`toolCallId`, `content` string) |
| `assistant`/`stream_event` (thinking) | `REASONING_MESSAGE_*` — **off by default** (version-dependent) |
| `result` (success) | `RUN_FINISHED` (`result`) + a `CUSTOM` `claude.usage` (per-turn tokens/cost) |
| `result` (error / is_error) | `RUN_ERROR` (`message`, `code`) |

`message_delta` / `message_stop` produce no AG-UI event (telemetry-only). The
`claude.usage` CUSTOM event carries each turn's tokens + cost so the client can
sum a session total that survives reconnect/replay.

## AG-UI output for `read → edit → report`

This is exactly what `npm run demo` prints from the recorded fixture:

```
RUN_STARTED               threadId=sess_7f3a runId=run_1
STATE_SNAPSHOT            {sessionId, model, cwd, permissionMode, tools, capabilities}
TEXT_MESSAGE_START        msg_a1
TEXT_MESSAGE_CONTENT ×2   "I'll read the config, " / "edit it, then report back."
TEXT_MESSAGE_END          msg_a1
TOOL_CALL_START           toolu_read  Read
TOOL_CALL_ARGS ×2         {"file_path":"/workspace/  +  config.json"}
TOOL_CALL_END             toolu_read
TOOL_CALL_RESULT          toolu_read  -> file contents
TEXT_MESSAGE_START/…/END  msg_a2  "Found retries=3. Bumping to 5."
TOOL_CALL_START/ARGS/END  toolu_edit  Edit
TOOL_CALL_RESULT          toolu_edit  "Applied 1 edit…"
TEXT_MESSAGE_START/…/END  msg_a3  "Done. …retries: 5 (was 3)."
RUN_FINISHED              result="Done. …"
```

## Model routing & auth

All of "which model, which credentials, what does a token cost" lives in
`agent/config/model.ts`. Precedence for the spawned child's model endpoint:

1. **Explicit `ANTHROPIC_BASE_URL`** — always wins.
2. **`ANTHROPIC_API_KEY` (opt-out)** — direct to `api.anthropic.com`, bare model
   id. This is the simple local path.
3. **Astro AI Gateway (default in-cluster)** — `ASTRO_GATEWAY_URL/anthropic`
   (Bifrost's Anthropic ingress → Bedrock). The virtual key goes via the
   `x-bf-vk` header (Bifrost ignores `Authorization`/`x-api-key`), model ids are
   `bedrock/`-prefixed to the gateway's served names, and Bedrock-incompatible
   pre-release `anthropic-beta` flags are disabled client-side.

**Sandboxed spawn env.** The child gets a *clean* env — an allowlist of
non-secret essentials (PATH/HOME, locale, proxy/TLS) plus only the model
credential and the user's `GH_TOKEN`. Everything else in the host env (AWS, DB,
gateway keys) is **dropped**, so neither the model nor a tool it runs
(`bash → env`) can read the container's secrets. Secrets are never logged;
`describeAuth()` prints a redacted summary.

## Cost → money

Prefer Claude's reported `result.total_cost_usd` (and per-model
`model_usage[].cost_usd`); fall back to `usage × pricing table` from
`config/model.ts`. In the demo these differ (reported `0.0429` vs computed
`0.0288`) because reported cost includes the full per-turn accumulated input
across the agentic loop, which the aggregate `usage` block doesn't reconstruct
— **so `total_cost_usd` is authoritative; the table is for fallback / the
gateway case.**

**Telemetry — SDK OpenInference spans (primary).** The Claude Agent SDK is
imported through `@astropods/adapter-claude-agent-sdk`, whose `query()` is
patched with OpenInference OTel instrumentation wired to Astro's tracer
provider. So query / sub-agent / tool / model spans flow to the Astro dashboard
automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and no-op locally — no
native-CLI telemetry env needed.

**Wrapper self-telemetry (opt-in).** `telemetry/otel.ts` also subscribes to the
same stream-json events and can emit bridge-level GenAI-semconv spans (root
`claude_code.run` + child `claude_code.tool`, token/cost attributes) via an
in-process OTLP/proto exporter — **off by default** to avoid double-emitting.
Enable with `BRIDGE_SELF_TELEMETRY=1` (plus an OTLP endpoint) for bridge/session
correlation spans.

| env | purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector (injected by the runner); unset ⇒ no export |
| `OTEL_SERVICE_NAME` | `service.name` (Dockerfile default `ada`) |
| `BRIDGE_SELF_TELEMETRY` | `1` to also emit wrapper-level spans (off by default; SDK spans are primary) |
| `OTEL_METRICS_ENABLED` | `1` to add wrapper OTLP metrics when self-telemetry is on |

Self-telemetry OTel dep versions mirror the proven `0.217.0` train used across
the other Astro agents.

---

## Pin list — unstable / version-dependent, pin before production

### Claude Code `stream-json` (pin the CLI version in the image)
1. **stream-json input/output is not a stable, versioned public contract.** The
   headless docs are thin and the input format is under-documented. Pin the exact
   `claude` version in the Dockerfile; treat a CLI bump as a breaking-change
   review. (The SDK yields the same envelopes, so this applies either way.)
2. **Feature-detect via `system/init.capabilities[]`, not a version string.**
   Whether `--include-partial-messages` yields `stream_event` deltas, and the
   exact partial shapes, can shift between releases.
3. **`result` cost/usage field names** (`total_cost_usd`, `model_usage[].cost_usd`,
   `cache_*_input_tokens`). Cost accuracy for billing depends on these — assert
   they're present in a startup smoke test; fall back to the pricing table if not.
4. **`--resume` does NOT replay prior events** — only a fresh `system/init` +
   the new turn. Client replay is entirely our registry's job.
5. **Claude Agent SDK is now the default source** (`@astropods/adapter-claude-agent-sdk`,
   re-exporting `@anthropic-ai/claude-agent-sdk`) — a typed message stream instead
   of scraping `claude -p` stdout, and the OTel seam. The CLI supervisor is kept
   as a fallback. Pin the SDK + adapter versions.

### AG-UI (pin `@ag-ui/core`)
6. **Reasoning events changed:** `THINKING_*` was removed in AG-UI **1.0.0** in
   favour of `REASONING_*`. We default reasoning OFF; if enabled, pin the core
   version so we emit the right names.
7. **`RUN_FINISHED.outcome`** is a newer optional field (Python SDK may emit
   `outcome: null`). We omit it for legacy-safety — revisit when we pin ≥ a
   version where it's expected.
8. **Validate against the canonical Zod schemas.** Local types in
   `agent/types/agui.ts` mirror `@ag-ui/core`; add a CI step that parses emitted
   events with the pinned package's schemas so drift fails the build.

### Gateway (Bifrost → Bedrock)
9. **`x-bf-vk` header + `bedrock/`-prefixed model ids** are how Bifrost reads the
   virtual key and resolves models; both were probed empirically and can change
   with the gateway. The Bedrock-incompatible `anthropic-beta` flags are disabled
   client-side (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) — revisit if the gateway
   starts accepting them. All overridable via env.

### Bridge-specific extension (document for frontends)
10. **SSE `id:` line for reconnect.** AG-UI's own SSE encoder emits only
    `data: {json}\n\n` (no `event:`/`id:`). We add `id: <seq>` so the browser's
    `EventSource` sends `Last-Event-ID` and we replay the gap from the registry.
    Valid SSE, ignored by clients that don't use it — but it's *our* extension
    to the transport, not part of AG-UI. Reconnect is by `session_id`, and the
    process outlives the connection.

## Next steps
- Registry durability: cap/spool the event log, GC terminated sessions, and
  clean up per-session workspaces (currently kept).
- Harden auth: sign the `bridge_uid` cookie, GC OAuth CSRF state, encrypt tokens
  at rest.
- Fix the outstanding `tsc` errors (adapter `getConfig` shape, `@types/pg`,
  OTel SDK types) and add a CI typecheck + AG-UI schema validation alongside the
  e2e workflow (see "Tests").
- Verify `claude`/the SDK boots headless in the container with only the gateway
  credential (no interactive onboarding/TTY).
</content>
