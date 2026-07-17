# Ayda

**Ayda** is a coding agent powered by Claude Code (repo dir: `claude-code-agui-bridge`).
Runs Claude Code headlessly in a container and re-emits its output as
**AG-UI** events over **SSE**, so any AG-UI-compatible frontend (CopilotKit,
custom dashboards) can consume it directly. An Astropods/K8s workload: a
wrapper process that supervises a `claude -p` session and exposes it over a
clean event API.

> **Why the name?** Named for **Ada Lovelace** (1815–1852), who wrote the first
> algorithm intended to be carried out by a machine and is widely regarded as the
> first computer programmer — a fitting namesake for an agent that writes and runs
> code for you. The Astropods blueprint deploys as **`ayda`** (a phonetic spelling
> of "Ada") because `ada` isn't a valid blueprint name.

> Status: **scaffold**. The translator + demo are complete and runnable; the
> supervisor, HTTP/MQ transports, OTel sink, and persistence are real but
> minimal, with `TODO`s where production hardening is needed.

## Run the demo (no API key, no network, no frontend)

Node ≥ 23 runs the TypeScript sources directly.

```bash
node scripts/demo-translate.ts        # AG-UI event list + sample SSE frames + cost summary
node scripts/demo-translate.ts --sse  # raw SSE frames only
```

It feeds `fixtures/read-edit-report.streamjson.jsonl` (a recorded Claude Code
`read → edit → report` run) through the translator and prints the AG-UI
payloads. This validates the mapping logic only — it does not spawn anything.
See "AG-UI output" below for the produced sequence.

## Run live locally (real `claude -p` + built-in test client)

Prerequisites on your machine: the `claude` CLI on `PATH`, and
`ANTHROPIC_API_KEY` exported (the bridge talks to Anthropic directly).

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # never logged; only passed to the child
node agent/index.ts                          # -> http://localhost:8080
```

Open `http://localhost:8080/`, type a prompt (e.g. "read package.json and tell
me the version"), and watch the AG-UI stream render as chat.

**Debug inspector (`?debug`):** the built-in client is a clean single-column
chat by default. Append **`?debug`** (`http://localhost:8080/?debug`) to reveal
a right-hand panel with the raw AG-UI events and their sequence numbers, plus
**Disconnect** / **Reconnect (replay)** buttons that demonstrate lossless
catch-up via `Last-Event-ID`. Dev/inspection tool only — hidden by default,
never part of an end-user UI. (The built-in client is itself a test harness;
real frontends like CopilotKit consume the same SSE stream.)

The client is a single dependency-free file (`public/index.html`) served
same-origin (no CORS, no build). Run the bridge from a directory you want Claude
to operate in, or set `cwd` in the supervisor options.

## Run on the Astro platform (container, cloud)

The agent is packaged for Astropods (`astropods.yml` + `Dockerfile` + `AGENT.md`).
Claude Code runs **inside the container** — the image bakes in the `claude` CLI,
and `models.anthropic.provider` injects `ANTHROPIC_API_KEY` at runtime.

```bash
ast project start        # build + run the container locally (frontend on :80)
# then deploy via your platform flow (see `ast docs`)
```

Key facts:
- `agent.interfaces.frontend: true` → the container listens on **port 80**
  (`Dockerfile` sets `PORT=80`; runs as root to bind it). The built-in AG-UI
  client + SSE API are served there and exposed at `ASTRO_EXTERNAL_AGENT_URL`.
- The `claude` CLI version is a **build arg** (`CLAUDE_CODE_VERSION`, default
  `latest`) — **pin it** in production (see Pin list #1).
- `spec: package/v1` / schema `astropods.ai` — matches current repos; the
  packaged migrate skill (v0.1.0) is behind on this. Confirm with `ast docs`.
- Verify on first container boot that `claude -p` runs headless with only
  `ANTHROPIC_API_KEY` (no interactive onboarding/TTY). This is the main
  unknown for the containerized path.

`dev.command` (`node --watch agent/index.ts`, port 8080) is the optional local
`ast dev` path — runs on the host, so it needs `claude` on the host PATH.

## Architecture

One internal pipeline, three sinks. The parsed stream-json event stream is the
single source of truth; the translator, telemetry, and persistence each
subscribe independently, so what the client sees can't drift from what's billed.

```
 HTTP / MQ (prompt in)
        │
        ▼
 ClaudeSupervisor ──spawns──▶  `claude -p --output-format stream-json` (NDJSON)
        │  emits parsed stream-json events
        ├──────────────▶ Translator ──▶ SessionRegistry (per-session AG-UI log, seq'd)
        │                                        │
        │                                        └──▶ SSE emitter (Last-Event-ID replay)
        ├──────────────▶ Telemetry (OTel traces + metrics; cost → $)
        └──────────────▶ ResultStore (final result persisted for billing)
```

| Module | Responsibility |
|---|---|
| `agent/config/model.ts` | **Isolated swap seam.** Model resolution from env/astropod.yaml, spawn-env (direct to Anthropic, no base URL), pricing table + cost. Gateway routing later changes *only this file*. |
| `agent/claude/agent.ts` | **Default source.** Runs the Claude Agent SDK `query()` with the `claude_code` system-prompt preset; yields typed messages (same envelopes as stream-json) → same Translator. The SDK spawns the `claude` binary (so it must be in the image); observability is Claude Code's native OTel. |
| `agent/claude/supervisor.ts` | Alternative source: spawns `claude -p` directly and parses NDJSON. Kept as a fallback; same event interface as the SDK source. |
| `agent/translate/translator.ts` | Pure stream-json/SDK-message → AG-UI mapping. Stateful per run. |
| `agent/session/registry.ts` | Per-session AG-UI event log with monotonic seq → lossless reconnect. Decoupled from transport. |
| `agent/transport/sse.ts` | AG-UI SSE framing + `Last-Event-ID` replay. |
| `agent/transport/transport.ts` | Inbound prompt transport interface + HTTP/MQ stubs. |
| `agent/telemetry/otel.ts` | OTel GenAI-semconv traces + metrics; cost. No-op without `@opentelemetry/api`. |
| `agent/persistence/results.ts` | Persist final `result` (cost, usage, turns) for billing/observability. |
| `agent/index.ts` | HTTP wiring skeleton. |

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
| `result` (success) | `RUN_FINISHED` (`result`) |
| `result` (error / is_error) | `RUN_ERROR` (`message`, `code`) |

`message_delta` / `message_stop` produce no AG-UI event (telemetry-only).

## AG-UI output for `read → edit → report`

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

## Cost → money

Prefer Claude's reported `result.total_cost_usd` (and per-model
`model_usage[].cost_usd`); fall back to `usage × pricing table` from
`config/model.ts`. In the demo these differ (reported `0.0429` vs computed
`0.0288`) because reported cost includes the full per-turn accumulated input
across the agentic loop, which the aggregate `usage` block doesn't reconstruct
— **so `total_cost_usd` is authoritative; the table is for fallback / the
gateway case.**

**Telemetry — native Claude Code OTel (primary).** Because the Agent SDK spawns
the Claude Code binary, the cleanest instrumentation is Claude Code's own OTel:
when an `OTEL_EXPORTER_OTLP_ENDPOINT` is present, `claudeCodeTelemetryEnv`
(in `telemetry/bootstrap.ts`) sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` + the
`OTEL_*` exporter vars on the SDK child, and Claude Code exports **traces,
metrics, and logs** directly — `claude_code.interaction` / `claude_code.llm_request`
/ `claude_code.tool` spans plus native token/cost metrics. That answers "tool
usage + tokens → money" with richer data than we'd hand-roll, and needs no
event parsing. (We gate it on the endpoint so local dev doesn't spew
localhost export errors; intervals are shortened so short runs flush.)

**Wrapper self-telemetry (opt-in).** `telemetry/bootstrap.ts` + `otel.ts` can
*also* emit bridge-level GenAI-semconv spans (root `claude_code.run` + child
`claude_code.tool`, token/cost attributes) via an in-process OTLP/proto exporter
— **off by default** to avoid double-emitting with native. Enable with
`BRIDGE_SELF_TELEMETRY=1` if you want bridge/session correlation spans.

| env | purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector (injected by the runner); unset ⇒ no telemetry |
| `OTEL_SERVICE_NAME` | `service.name` (default `claude-code-agui-bridge`) |
| `BRIDGE_SELF_TELEMETRY` | `1` to also emit wrapper-level spans (off by default; native is primary) |
| `OTEL_METRICS_ENABLED` | `1` to add wrapper OTLP metrics when self-telemetry is on |

Cost source (for the wrapper/persistence path): `result.total_cost_usd` first,
pricing-table fallback. Self-telemetry OTel dep versions mirror the proven
`0.217.0` train used across the other Astro agents.

---

## Pin list — unstable / version-dependent, pin before production

### Claude Code `stream-json` (pin the CLI version in the image)
1. **stream-json input/output is not a stable, versioned public contract.** The
   headless docs are thin and the input format is under-documented (tracked in
   `anthropics/claude-code` issues). Pin the exact `claude` version in the
   Dockerfile; treat a CLI bump as a breaking-change review.
2. **Feature-detect via `system/init.capabilities[]`, not a version string.**
   Whether `--include-partial-messages` yields `stream_event` deltas, and the
   exact partial shapes, can shift between releases.
3. **`result` cost/usage field names** (`total_cost_usd`, `model_usage[].cost_usd`,
   `cache_*_input_tokens`). Cost accuracy for billing depends on these — assert
   they're present in a startup smoke test; fall back to the pricing table if not.
4. **Required flag combo:** stream-json output needs `--verbose`; token deltas
   need `--include-partial-messages`. Both are load-bearing for the mapping.
5. **`--resume` does NOT replay prior events** — only a fresh `system/init` +
   the new turn. Client replay is entirely our registry's job (below).
6. **Consider the Claude Agent SDK as an alternative** to scraping the CLI: the
   `@anthropic-ai/claude-agent-sdk` exposes the same session as typed messages
   and is a more stable surface than parsing `claude -p` stdout. Worth a spike
   before committing to the CLI-wrapping approach long-term.

### AG-UI (pin `@ag-ui/core`)
7. **Reasoning events changed:** `THINKING_*` was removed in AG-UI **1.0.0** in
   favour of `REASONING_*`. We default reasoning OFF; if enabled, pin the core
   version so we emit the right names.
8. **`RUN_FINISHED.outcome`** is a newer optional field (Python SDK may emit
   `outcome: null`). We omit it for legacy-safety — revisit when we pin ≥ a
   version where it's expected.
9. **Validate against the canonical Zod schemas.** Local types in
   `agent/types/agui.ts` mirror `@ag-ui/core`; add a CI step that parses emitted
   events with the pinned package's schemas so drift fails the build.

### Bridge-specific extension (document for frontends)
10. **SSE `id:` line for reconnect.** AG-UI's own SSE encoder emits only
    `data: {json}\n\n` (no `event:`/`id:`). We add `id: <seq>` so the browser's
    `EventSource` sends `Last-Event-ID` and we replay the gap from the registry.
    Valid SSE, ignored by clients that don't use it — but it's *our* extension
    to the transport, not part of AG-UI. Reconnect is by `session_id`, and the
    process outlives the connection.

## Next steps
- Smoke test against a real `claude` binary (needs `ANTHROPIC_API_KEY`); assert
  the `result` cost/usage fields exist.
- Wire the OTel SDK + OTLP exporter via `astropods:wire-astropods-telemetry`.
- Multi-turn: keep stdin open, add `POST /sessions/:id/messages`.
- Registry durability: cap/spool the event log, GC terminated sessions.
- Decide HTTP vs MQ transport; auth on the SSE + POST endpoints.
