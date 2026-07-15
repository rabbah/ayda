---
description: "Ada — a coding agent (powered by Claude Code) you talk to over Slack, web chat, or an AG-UI/SSE frontend."
tags: [ada, claude-code, ag-ui, sse, slack, wrapper]
capabilities:
  - "Supervises a headless `claude -p` session inside the container"
  - "Translates Claude Code stream-json events into AG-UI protocol events, one-to-one"
  - "Re-emits AG-UI events over SSE with lossless reconnect (Last-Event-ID replay)"
  - "Serves an AG-UI-compatible frontend; external AG-UI clients (e.g. CopilotKit) can also consume the stream"
  - "Persists the final run result (cost, usage) and exports OTel traces/metrics"
integrations: []
---

## Overview

**Ada** is a coding agent powered by Claude Code. A wrapper process supervises a
`claude -p` session and exposes it over a clean event API — converse with Ada
over Slack / web chat (the platform messaging sidecar) or any AG-UI frontend.
Claude Code runs headless inside the container; its
newline-delimited `stream-json` output is translated into
[AG-UI](https://docs.ag-ui.com) protocol events and streamed to the browser
over Server-Sent Events. Any AG-UI-compatible frontend can render the run — a
plain chat UI or a richer dashboard — without backend changes.

The agent talks to Anthropic directly; `models.anthropic.provider` injects
`ANTHROPIC_API_KEY` into the container.

## Usage

Open the agent's frontend URL and send a prompt (e.g. "read config.json and
bump the retries"). You'll see streaming assistant text, tool-call cards with
live arguments, tool results, and a final result — as AG-UI events. External
clients can POST `/sessions` and stream `GET /sessions/:id/events`.

## Limitations

- Single-turn per session in the current scaffold (multi-turn is planned).
- The stream-json contract is version-dependent — the `claude` CLI version is
  pinned in the Dockerfile; see the repo README "Pin list".
