/**
 * Per-session sandbox workspace.
 *
 * The Claude child inherits the Node process CWD, which in the container is
 * `/app` (Dockerfile WORKDIR) — the read-only source tree. Every run would
 * otherwise share it and be unable to write. Instead we give each run its own
 * writable directory (containing its repo checkout, see repo.ts) and pass it as
 * the SDK `cwd`.
 *
 * Set WORKSPACE_ROOT to a persistent volume in production (a Slack thread may
 * resume days later); it defaults to `tmpdir()` for local dev. Stale workspaces
 * are reclaimed by a TTL sweep (startWorkspaceGc) so per-thread clones don't fill
 * the disk — the analog of cruise-line's `/cleanup`.
 */

import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.WORKSPACE_ROOT || tmpdir();
const PREFIX = "ada-";

/** Create a fresh, writable per-session workspace; returns its absolute path. */
export function createWorkspace(prefix = PREFIX): string {
  mkdirSync(ROOT, { recursive: true });
  return mkdtempSync(join(ROOT, prefix));
}

/**
 * Reuse a previously-recorded workspace path, recreating it if the container was
 * restarted (the dir may be gone even though a resume mapping survived). Returns
 * a usable path.
 */
export function ensureWorkspace(path: string | null): string {
  return path && existsSync(path) ? path : createWorkspace();
}

/** Best-effort removal of a session workspace and its contents (on delete). */
export function removeWorkspace(path: string | null | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* best-effort — the dir may already be gone */
  }
}

/**
 * Delete workspaces under ROOT whose last modification is older than maxAgeMs.
 * mtime advances as the repo checkout is written to, so an actively-used thread's
 * workspace stays alive; only idle ones are reclaimed. Returns the count removed.
 * Best-effort: a workspace mid-run is unlikely to be stale, but a delete racing a
 * live run is swallowed rather than crashing the sweep.
 */
export function sweepWorkspaces(maxAgeMs: number, now: number): number {
  if (!existsSync(ROOT)) return 0;
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const name of readdirSync(ROOT)) {
    if (!name.startsWith(PREFIX)) continue; // only our own dirs
    const full = join(ROOT, name);
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* concurrent delete / permission race — skip */
    }
  }
  return removed;
}

/**
 * Periodically reclaim idle workspaces. Returns a stop function. `now` is passed
 * in at call time (Date.now() is unavailable in some contexts); the interval
 * captures it lazily via the injected clock.
 */
export function startWorkspaceGc(
  opts: { intervalMs?: number; maxAgeMs?: number; clock?: () => number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000; // hourly
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24h idle
  const clock = opts.clock ?? (() => Date.now());
  const timer = setInterval(() => {
    try {
      const n = sweepWorkspaces(maxAgeMs, clock());
      if (n > 0) console.log(`[workspace] gc reclaimed ${n} idle workspace(s)`);
    } catch (e) {
      console.warn(`[workspace] gc sweep failed: ${(e as Error).message}`);
    }
  }, intervalMs);
  timer.unref?.(); // don't keep the process alive for GC alone
  return () => clearInterval(timer);
}
