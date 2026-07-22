/**
 * Per-thread repo checkout.
 *
 * A conversation (Slack thread / web session) is one task on one repo. The user
 * binds it with `work on <owner/repo>`; we clone that repo once into the thread's
 * workspace and reuse it across turns. This is the read-WRITE analog of
 * cruise-line's per-PR clone dirs: cruise-line shares a read-only clone and
 * `git clean`s between runs, but Ayda edits/commits, so every thread gets its own
 * isolated checkout that is NOT reset between turns (work-in-progress is kept).
 *
 * Auth uses the image's git credential helper (`gh auth git-credential`) fed by
 * GH_TOKEN, so the token is never written into `.git/config` (unlike embedding it
 * in the clone URL). Private repos require the user to have connected GitHub and
 * installed the App on the repo.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RepoSpec {
  owner: string;
  repo: string;
}

/** Parse `owner/repo`, a full GitHub URL, or `github.com/owner/repo`. */
export function parseRepoSpec(input: string): RepoSpec | null {
  const t = input.trim().replace(/\.git$/i, "");
  const m = t.match(/^(?:https?:\/\/)?(?:github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Directory the repo is checked out to inside a workspace (one repo per thread). */
export function repoDir(workspaceDir: string, spec: RepoSpec): string {
  return join(workspaceDir, spec.repo);
}

async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    await exec("git", ["-C", dir, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

// One clone at a time per workspace: a second turn arriving mid-clone waits for
// the first rather than racing a half-cloned tree.
const cloneLocks = new Map<string, Promise<unknown>>();

async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = cloneLocks.get(key);
  const run = (async () => {
    if (prior) await prior.catch(() => {});
    return fn();
  })();
  cloneLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (cloneLocks.get(key) === run) cloneLocks.delete(key);
  }
}

export interface EnsureRepoResult {
  /** Absolute path to the checked-out repo — use as the Claude `cwd`. */
  dir: string;
  /** True when it was freshly cloned this call (vs reused from a prior turn). */
  cloned: boolean;
}

/**
 * Ensure `spec` is checked out in `workspaceDir` and return its path. Clones on
 * first use, reuses the existing checkout on later turns (no reset — WIP is
 * preserved). `githubToken` is passed to git via GH_TOKEN for private repos.
 */
export async function ensureRepo(
  workspaceDir: string,
  spec: RepoSpec,
  opts: { githubToken?: string } = {},
): Promise<EnsureRepoResult> {
  const dir = repoDir(workspaceDir, spec);
  return withCloneLock(dir, async () => {
    if (await isGitRepo(dir)) return { dir, cloned: false };
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv;
    if (opts.githubToken) env.GH_TOKEN = opts.githubToken;
    // Credential-helper auth (gh vends GH_TOKEN); token stays out of .git/config.
    await exec("git", ["clone", "--depth=1", `https://github.com/${spec.owner}/${spec.repo}.git`, dir], {
      env,
      cwd: workspaceDir,
    });
    return { dir, cloned: true };
  });
}
