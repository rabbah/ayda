# Node 24 runs the .ts sources natively via type-stripping (requires >= 23).
FROM node:24-slim

# --- Claude Code CLI -------------------------------------------------------
# The whole point of this container: the bridge spawns `claude -p` (see
# src/claude/supervisor.ts), so the CLI must be present in the image.
# PIN the version in production — the stream-json contract is not stable across
# releases (see README "Pin list" #1). Override at build time:
#   ast/docker build --build-arg CLAUDE_CODE_VERSION=<x.y.z>
ARG CLAUDE_CODE_VERSION=latest
# git + curl + ca-certs, then the GitHub CLI (`gh`) from its official apt repo,
# then Claude Code. `gh` + git let the agent do authenticated GitHub work
# (clone/push/PR) inside the container. NOTE: no inline `#` comments inside this
# RUN — line continuations collapse to one shell line and a `#` would comment
# out the rest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# git uses gh's credential helper for github.com; gh vends whatever token is in
# GH_TOKEN at runtime — we inject the user's per-session OAuth token there. No
# static token baked in; nothing to strip if a session is unauthenticated.
RUN git config --system credential."https://github.com".helper "!gh auth git-credential"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=80 \
    GIT_TERMINAL_PROMPT=0 \
    OTEL_SERVICE_NAME=ada

# Only runtime dependency is @opentelemetry/api (telemetry degrades to no-op if
# absent). devDeps (typescript, @ag-ui/core) are not needed at runtime.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# agent.interfaces.frontend => the container MUST listen on port 80. We run as
# root to bind it. We do NOT pass `--dangerously-skip-permissions`, so `claude`
# runs fine as root; permissions are constrained via --permission-mode +
# --allowedTools in the supervisor.
EXPOSE 80
CMD ["node", "src/index.ts"]
