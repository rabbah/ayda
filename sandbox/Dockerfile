# Ayda execution sandbox — isolated, secret-less Claude Code runner.
# Built from the repo root (context: .) so it can share agent/ source with the
# control plane; run as: docker build -f sandbox/Dockerfile .
# Node 24 runs the .ts sources natively via type-stripping (requires >= 23).
FROM node:24-slim

# This container runs the `claude` binary (spawned by the Claude Agent SDK) and
# git operations on per-conversation repo checkouts, so it needs the CLI, git,
# and gh. PIN CLAUDE_CODE_VERSION in production. NOTE: no inline `#` inside the
# RUN — line continuations collapse to one shell line.
ARG CLAUDE_CODE_VERSION=latest
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

# Bake the Go toolchain in (these are Go repos) so the agent never re-downloads
# ~60MB of toolchain per run. Pin GO_VERSION to what the target repos need.
ARG GO_VERSION=1.25.0
RUN ARCH=$(dpkg --print-architecture) \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz

# git uses gh's credential helper; gh vends the per-request GH_TOKEN the control
# plane forwards, so a user's token is never written into .git/config.
RUN git config --system credential."https://github.com".helper "!gh auth git-credential"

WORKDIR /app
# WORKSPACE_ROOT is set here (not just in code) so session/workspace.ts computes
# the SAME root at import time — the GC sweeps the volume we actually clone into.
#
# Go build tuning for a SMALL container (platform default: ~1 GiB / 100m CPU,
# not raisable via astropods.yml — OOM-kills a cgo/full-tree build otherwise):
#   - GOMODCACHE/GOCACHE on the /data volume so modules + build cache SURVIVE
#     across requests (skip re-download + re-compile of the dep tree — the
#     dominant cost) instead of the ephemeral $HOME.
#   - GOMEMLIMIT below the container's working-set ceiling (leaving headroom for
#     the Node sandbox+claude baseline ~300MiB) → the Go tools GC hard instead of
#     OOMing.
#   - GOMAXPROCS=1 → `go build` default -p becomes 1 (serial package compiles),
#     so peak memory is one compiler, not N in parallel. (100m CPU throttles
#     parallelism anyway; this bounds memory.)
ENV NODE_ENV=production \
    PORT=3000 \
    WORKSPACE_ROOT=/data/workspaces \
    GIT_TERMINAL_PROMPT=0 \
    OTEL_SERVICE_NAME=ayda-sandbox \
    PATH="/usr/local/go/bin:${PATH}" \
    GOMODCACHE=/data/cache/go/mod \
    GOCACHE=/data/cache/go/build \
    GOFLAGS=-mod=mod \
    GOMEMLIMIT=600MiB \
    GOMAXPROCS=1 \
    GOTOOLCHAIN=local \
    npm_config_cache=/data/cache/npm \
    PIP_CACHE_DIR=/data/cache/pip

# Install deps at /app so the Agent SDK dynamic-import (from agent/claude/…) and
# sandbox/ both resolve node_modules via the normal upward lookup.
COPY sandbox/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Shared control-plane source (agent/) + the sandbox server.
COPY agent ./agent
COPY sandbox ./sandbox

EXPOSE 3000
CMD ["node", "sandbox/index.ts"]
