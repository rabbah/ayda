/**
 * Per-session sandbox workspace.
 *
 * The Claude child inherits the Node process CWD, which in the container is
 * `/app` (Dockerfile WORKDIR) — the read-only source tree. Every run would
 * otherwise share it and be unable to write. Instead we give each run its own
 * writable temp directory and pass it as the SDK `cwd` (see claude/agent.ts).
 *
 * SCAFFOLD NOTE: workspaces are kept (no cleanup) — matching the in-memory
 * "session GC is a TODO" posture elsewhere. The OS clears `tmpdir()` on reboot;
 * add TTL/GC before production if disk pressure becomes a concern. Base dir is
 * overridable via WORKSPACE_ROOT.
 */

import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.WORKSPACE_ROOT || tmpdir();

/** Create a fresh, writable per-session workspace; returns its absolute path. */
export function createWorkspace(prefix = "ada-"): string {
  mkdirSync(ROOT, { recursive: true });
  return mkdtempSync(join(ROOT, prefix));
}

/**
 * Reuse a previously-recorded workspace path, recreating it if the container was
 * restarted (tmp is ephemeral, so the dir may be gone even though a resume
 * mapping survived). Returns a usable path.
 */
export function ensureWorkspace(path: string | null): string {
  return path && existsSync(path) ? path : createWorkspace();
}
