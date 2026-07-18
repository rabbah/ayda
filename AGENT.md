---
description: "Ayda — a coding agent (powered by Claude Code) you talk to over Slack, web chat, or an AG-UI/SSE frontend."
tags: [ayda, claude-code, ag-ui, sse, slack, github, wrapper]
capabilities:
  - "Runs a Claude Code session via the Claude Agent SDK inside the container"
  - "Translates Claude Code stream-json events into AG-UI protocol events, one-to-one"
  - "Re-emits AG-UI events over SSE with lossless reconnect (Last-Event-ID replay)"
  - "Serves an AG-UI-compatible frontend; external AG-UI clients (e.g. CopilotKit) can consume the stream"
  - "Connects each user's GitHub via per-user OAuth so git/gh act as them"
  - "Persists the final run result (cost, usage) and exports OTel traces/metrics"
repository: github:Simwar/ada
integrations: [GitHub, Slack]
---

## Overview

**Ayda** is a coding agent powered by Claude Code. A wrapper process runs a
Claude Code session (via the Claude Agent SDK) and exposes it over a clean event
API — converse with Ayda over Slack / web chat (the platform messaging sidecar)
or any AG-UI frontend. Claude Code runs headless inside the container; its
newline-delimited `stream-json` output is translated into
[AG-UI](https://docs.ag-ui.com) protocol events and streamed to the browser
over Server-Sent Events. Any AG-UI-compatible frontend can render the run — a
plain chat UI or a richer dashboard — without backend changes.

Model calls route through the Astro AI Gateway (`astro_ai_gateway: true`), so
the container needs no personal `ANTHROPIC_API_KEY`.

> **Why the name?** *Ayda* is a phonetic spelling of **Ada**, after Ada Lovelace
> — widely regarded as the first computer programmer — a fitting namesake for a
> coding agent. The blueprint is `ayda` because `ada` isn't a valid name.

## Usage

Message Ayda over Slack / web chat, or open the agent's frontend URL and send a
prompt (e.g. "read config.json and bump the retries"). You'll see streaming
assistant text, tool-call cards with live arguments, tool results, and a final
result — as AG-UI events. External clients can POST `/sessions` and stream
`GET /sessions/:id/events`.

## GitHub

Ayda can act on GitHub as the individual user it's talking to — no static token
baked into the container.

- **Connect** — a user runs `/connect-github` in a DM; Ayda replies with a link
  to authorize. Their token is stored per-user and injected as `GH_TOKEN`, so
  `git` and `gh` inside the Claude session act as them.
- **Set up** — an admin (whose verified email is listed in `ADMIN_EMAILS`) opens
  the web UI and clicks **Set up GitHub App** to provision the App through
  GitHub's App-Manifest flow. No manual App registration, no client id/secret to
  copy. (Setup is web-only: admin is verified by email, which chat doesn't carry.)

## Limitations

- Single-turn per session in the current scaffold (multi-turn is planned).
- The stream-json contract is version-dependent — the `claude` CLI version is
  pinned in the Dockerfile; see the repo README "Pin list".
