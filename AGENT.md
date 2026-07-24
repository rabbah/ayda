---
description: "Ada — a coding agent (powered by Claude Code) you talk to over Slack, web chat, or an AG-UI/SSE frontend."
tags: [ada, claude-code, ag-ui, sse, slack, github, wrapper]
capabilities:
  - "Runs a Claude Code session via the Claude Agent SDK inside the container"
  - "Holds multi-turn conversations, resuming session context across follow-up turns"
  - "Isolates each session in its own writable sandbox workspace"
  - "Scrubs the spawned agent's env so tools can't read host secrets (AWS/DB/gateway)"
  - "Translates Claude Code stream-json events into AG-UI protocol events, one-to-one"
  - "Re-emits AG-UI events over SSE with lossless reconnect (Last-Event-ID replay)"
  - "Serves an AG-UI-compatible frontend; external AG-UI clients (e.g. CopilotKit) can consume the stream"
  - "Connects each user's GitHub via per-user OAuth so git/gh act as them"
  - "Persists the final run result (cost, usage) and exports OTel traces/metrics"
repository: github:rabbah/ada
integrations: [GitHub, Slack]
---

## Overview

**Ada** is a coding agent powered by Claude Code. A wrapper process runs a
Claude Code session (via the Claude Agent SDK) and exposes it over a clean event
API — converse with Ada over Slack / web chat (the platform messaging sidecar)
or any AG-UI frontend. Claude Code runs headless inside the container; its
newline-delimited `stream-json` output is translated into
[AG-UI](https://docs.ag-ui.com) protocol events and streamed to the browser
over Server-Sent Events. Any AG-UI-compatible frontend can render the run — a
plain chat UI or a richer dashboard — without backend changes.

Each session gets its own writable sandbox workspace as its working directory,
and the spawned agent runs with a scrubbed environment: only the essentials
(PATH/HOME, proxy/TLS, the model credential, and the user's GitHub token) are
forwarded, so a tool the model runs — e.g. `bash` → `env` — can't read the
container's host secrets (AWS, database, gateway keys).

Model calls route through the Astro AI Gateway (`astro_ai_gateway: true`), so
the container needs no personal `ANTHROPIC_API_KEY`. Supplying one as an input
opts out of the gateway and talks to Anthropic directly.

> **Why the name?** Named after **Ada Lovelace** — widely regarded as the first
> computer programmer — a fitting namesake for a coding agent. The Astropods
> blueprint deploys as `ada-your-personal-coding-agent` because a bare `ada`
> isn't a valid blueprint name.

## Usage

Message Ada over Slack / web chat, or open the agent's frontend URL and send a
prompt (e.g. *"read config.json and bump the retries"*). You'll see streaming
assistant text, tool-call cards with live arguments, tool results, and a final
result — as AG-UI events. Keep replying to continue the same session: follow-up
turns resume the prior context in the same workspace. The built-in UI shows a
per-session token/cost readout, a session-history switcher, and a settings panel
(GitHub status + connect/setup actions).

External clients can drive the same pipeline over HTTP:

- **`POST /sessions`** `{prompt, allowedTools?, permissionMode?}` → `{sessionId}` (starts a session)
- **`POST /sessions/:id/messages`** `{prompt}` → continue that session with a follow-up turn
- **`GET /sessions/:id/events`** → SSE AG-UI stream; honours `Last-Event-ID` for lossless replay

## GitHub

Ada can act on GitHub as the individual user it's talking to — no static token
baked into the container.

- **Connect** — a user runs `/connect-github` in a DM (or clicks **Connect
  GitHub** in the web UI); Ada replies with a link to authorize. Their token is
  stored per-user and injected as `GH_TOKEN`, so `git` and `gh` inside the Claude
  session act as them.
- **Set up** — an admin (whose verified email is listed in `ADMIN_EMAILS`) opens
  the web UI and clicks **Set up GitHub App** to provision the App through
  GitHub's App-Manifest flow. No manual App registration, no client id/secret to
  copy. The App is provisioned **private** by default (single-tenant); set
  `GITHUB_APP_PUBLIC=true` for multi-tenant so other users can install it on their
  own repos and connect. (Setup is web-only: admin is verified by email, which chat doesn't carry.
  If `ADMIN_EMAILS` is unset, any signed-in user can perform the *initial* setup;
  provisioning then locks.)

## Limitations

- Sessions, the AG-UI event log, and GitHub OAuth CSRF state live in memory /
  Postgres with no GC yet; sandbox workspaces are kept, not cleaned up.
- One turn runs at a time per session — an overlapping follow-up gets `409 busy`.
- The stream-json contract is version-dependent — the `claude` CLI version is
  pinned in the Dockerfile; see the repo README "Pin list".
</content>
</invoke>
