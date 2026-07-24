/**
 * Astro messaging AgentAdapter for Claude Code.
 *
 * Lets the platform's messaging sidecar (web / Slack / …) converse with Claude
 * Code: the sidecar hands us a normalized message per conversation; we run a
 * Claude Code session and stream the response back through the hooks.
 *
 * Concurrency model (Slack = multi-threaded):
 *  - The sidecar dispatches conversations concurrently, so different Slack threads
 *    run at once. Each thread (conversationId) has its OWN workspace + repo
 *    checkout + Claude session — the isolation unit is the thread.
 *  - A run holds a slot in `runLimiter` (MAX_CONCURRENT_RUNS) so N threads don't
 *    spawn N `claude` children and OOM the box; excess threads queue.
 *  - A new message supersedes an in-flight one in the SAME thread: the sidecar
 *    aborts `options.signal`, which we forward to `source.stop()` so the old
 *    `claude` child actually dies instead of racing the new one in one workspace.
 *
 * Repos: one repo per thread (one task). `work on <owner/repo>` clones it into the
 * thread's workspace once and reuses it across turns (see session/repo.ts).
 */

import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import { ClaudeAgentSession } from "../claude/agent.ts";
import { ensureWorkspace } from "../session/workspace.ts";
import { ensureRepo, parseRepoSpec, type RepoSpec } from "../session/repo.ts";
import { runLimiter } from "../concurrency.ts";
import { SandboxSession, sandboxEnabled, sandboxEnsureRepo } from "../sandbox-client.ts";
import { Translator } from "../translate/translator.ts";
import { resolveModel } from "../config/model.ts";
import { EventType } from "../types/agui.ts";
import type { Store } from "../store/store.ts";
import type { SessionRegistry } from "../session/registry.ts";
import { getValidToken } from "../auth/github-app.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getServerSecret, buildConnectUrl } from "../auth/connect.ts";
import { githubPromptGuidance } from "../github-guidance.ts";

const CONV_NS = "conv_claude_session"; // conversationId -> claude session_id (for --resume)
const HINT_NS = "gh_connect_hint"; // conversationId -> "1" once the connect hint has been shown
const WS_NS = "conv_workspace"; // conversationId -> workspace path (reused across resumed turns)
const REPO_NS = "conv_repo"; // conversationId -> { owner, repo } bound to this thread

type Directive =
  | { kind: "connect" }
  | { kind: "setup"; org?: string }
  | { kind: "whoami" }
  | { kind: "work"; spec: RepoSpec | null };

/** Parse a whole-message directive, or null if the message isn't one. */
function parseDirective(prompt: string): Directive | null {
  // Strip leading Slack mentions: addressing the bot in a channel prepends
  // `<@U123>` (or `<@U123|name>`), so `@Ada connect github` arrives as
  // `<@U123> connect github`. Without this the exact-match directives below never
  // fire in channels and fall through to a (slow, costly) LLM turn instead.
  const t = prompt.replace(/^\s*(?:<@[^>]+>\s*)+/, "").trim();
  const lower = t.toLowerCase().replace(/^\//, "");
  if (lower === "whoami") return { kind: "whoami" };
  if (lower === "connect-github" || lower === "connect github") return { kind: "connect" };
  const setup = t.match(/^\/?setup-github(?:\s+(\S+))?\s*$/i);
  if (setup) return { kind: "setup", org: setup[1] };
  // `work on <repo>` or `/work <repo>` — bind this thread to a repo.
  const work = t.match(/^\/?work(?:\s+on)?\s+(\S+)\s*$/i);
  if (work) return { kind: "work", spec: parseRepoSpec(work[1]) };
  if (/^\/?work(\s+on)?\s*$/i.test(t)) return { kind: "work", spec: null }; // usage
  return null;
}

/**
 * Whether the conversation is private: a Slack DM, or a non-platform web/
 * playground session (no platformContext, inherently 1:1). Connect links must
 * only be handed out here — in a shared channel anyone could click one within its
 * TTL and bind their own GitHub to this user's identity.
 */
function isPrivate(options: StreamOptions): boolean {
  const ctx = options.platformContext as { eventKind?: string } | undefined;
  return !ctx || ctx.eventKind === "EVENT_KIND_DM";
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "Ada";
  private readonly store: Store;
  private readonly allowedTools: string[];
  /** Optional: mirror each turn's AG-UI events here so the frontend can review
   *  the conversations the agent handled over Slack/web. */
  private readonly registry?: SessionRegistry;

  constructor(store: Store, allowedTools: string[] = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"], registry?: SessionRegistry) {
    this.store = store;
    this.allowedTools = allowedTools;
    this.registry = registry;
  }

  getConfig() {
    return {
      systemPrompt: "Claude Code (claude_code system-prompt preset)",
      tools: this.allowedTools.map((name) => ({ name })),
    };
  }

  /** Resolve a valid per-user GitHub token, or undefined if unconfigured/unconnected. */
  private async token(userId: string): Promise<string | undefined> {
    return githubConfigured() ? ((await getValidToken(this.store, userId)) ?? undefined) : undefined;
  }

  /** The writable workspace for a conversation (reused across turns, self-heals). */
  private async workspace(conversationId: string): Promise<string> {
    const stored = (await this.store.kvGet(WS_NS, conversationId)) as string | null;
    const cwd = ensureWorkspace(stored);
    if (cwd !== stored) await this.store.kvPut(WS_NS, conversationId, cwd);
    return cwd;
  }

  /** Handle a directive (whoami / connect / setup / work): validate, reply, no LLM run. */
  private async runDirective(directive: Directive, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    const reply = (msg: string) => {
      hooks.onChunk(msg);
      hooks.onFinish();
    };
    if (directive.kind === "whoami") {
      const rec = githubConfigured() ? await this.store.getGithubToken(options.userId) : null;
      const bound = (await this.store.kvGet(REPO_NS, options.conversationId)) as RepoSpec | null;
      const gh = !githubConfigured()
        ? "not set up on this agent"
        : rec
          ? `connected as ${rec.githubLogin ?? "your account"}`
          : "not connected — send `connect github` to connect";
      reply(
        `Your messaging identity:\n` +
          `• userId: \`${options.userId}\`\n` +
          `• github: ${gh}\n` +
          `• this thread: ${bound ? `working on \`${bound.owner}/${bound.repo}\`` : "no repo yet — say `work on owner/repo`"}`,
      );
      return;
    }
    if (directive.kind === "setup") {
      reply(
        `GitHub App setup moved to the web UI. Open the app and click "Set up GitHub App". ` +
          `Chat can't run setup — it needs your signed-in web identity, which isn't available here.`,
      );
      return;
    }
    if (directive.kind === "work") {
      if (!directive.spec) {
        reply("Tell me which repo to work on in this thread: `work on owner/repo`. One repo per thread — start a new thread for a different repo/task.");
        return;
      }
      const spec = directive.spec;
      const existing = (await this.store.kvGet(REPO_NS, options.conversationId)) as RepoSpec | null;
      if (existing && (existing.owner !== spec.owner || existing.repo !== spec.repo)) {
        reply(
          `This thread is already working on \`${existing.owner}/${existing.repo}\`. ` +
            `One repo per thread — start a **new** thread to work on \`${spec.owner}/${spec.repo}\`.`,
        );
        return;
      }
      const githubToken = await this.token(options.userId);
      try {
        // Provision where execution happens: locally (in-process) or in the sandbox.
        const r = sandboxEnabled()
          ? await sandboxEnsureRepo(options.conversationId, spec, githubToken)
          : await ensureRepo(await this.workspace(options.conversationId), spec, { githubToken });
        await this.store.kvPut(REPO_NS, options.conversationId, spec);
        reply(
          `${r.cloned ? "Cloned" : "Reusing"} \`${spec.owner}/${spec.repo}\`. This thread is now working on it — ` +
            `ask me to read code, make changes, or open a PR.`,
        );
      } catch (e) {
        reply(
          `Couldn't check out \`${spec.owner}/${spec.repo}\`: ${(e as Error).message}\n` +
            (githubToken ? "Make sure I'm installed on that repo." : "Connect GitHub first — send `connect github` — then try again."),
        );
      }
      return;
    }
    // connect — DM-only: the link binds to your identity, so a channel would leak it.
    if (!isPrivate(options)) {
      reply(`Please DM me to connect GitHub — a link posted in a channel would be visible to everyone here.`);
      return;
    }
    if (!githubConfigured()) {
      reply(
        "GitHub isn't set up on this agent yet. An admin has to set up the GitHub App once — in the web app, open Settings → \"Set up GitHub App\" (it needs your signed-in web identity, so it can't be done from chat). After that, send `connect github` here and I'll give you a link to connect your account.",
      );
      return;
    }
    const secret = await getServerSecret(this.store);
    reply(`Open this link to install me on the repositories you want me to work with — you pick the repos, and it connects your GitHub in the same step (expires in 10 min):\n${buildConnectUrl(options.userId, secret)}`);
  }

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    // Already superseded/stopped before we began — nothing to do.
    if (options.signal?.aborted) {
      hooks.onFinish();
      return;
    }

    const directive = parseDirective(prompt);
    if (directive) {
      await this.runDirective(directive, hooks, options);
      return;
    }

    const model = resolveModel();
    const resume = (await this.store.kvGet(CONV_NS, options.conversationId)) as string | null;
    const githubToken = await this.token(options.userId);
    // Tell the model how GitHub auth works here so it guides the user to
    // /connect-github instead of improvising PAT/`gh auth login` advice.
    const systemPromptAppend = githubPromptGuidance({ configured: githubConfigured(), connected: !!githubToken });

    const boundRepo = (await this.store.kvGet(REPO_NS, options.conversationId)) as RepoSpec | null;
    const useSandbox = sandboxEnabled();

    // Each thread has its own workspace + repo checkout. In-process mode resolves
    // them locally and cd's into the checkout; sandbox mode delegates both to the
    // sandbox container (keyed by conversationId), so nothing is cloned here.
    let cwd = "";
    if (!useSandbox) {
      cwd = await this.workspace(options.conversationId);
      if (boundRepo) {
        try {
          cwd = (await ensureRepo(cwd, boundRepo, { githubToken })).dir;
        } catch (e) {
          hooks.onChunk(`⚠️ Couldn't prepare \`${boundRepo.owner}/${boundRepo.repo}\`: ${(e as Error).message}`);
          hooks.onFinish();
          return;
        }
      }
    }

    // GitHub is available but this user hasn't connected: show a one-time hint.
    let hintUrl: string | null = null;
    if (githubConfigured() && !githubToken && !(await this.store.kvGet(HINT_NS, options.conversationId))) {
      hintUrl = buildConnectUrl(options.userId, await getServerSecret(this.store));
    }

    // Register this thread so the frontend conversation-review UI can list/replay
    // it. Keyed by conversationId; browser sessions use their own bridge ids.
    this.registry?.ensure(options.conversationId);
    this.registry?.setMeta(options.conversationId, {
      kind: "slack",
      userId: options.userId,
      repo: boundRepo ? `${boundRepo.owner}/${boundRepo.repo}` : undefined,
      title: prompt.slice(0, 80),
    });
    this.registry?.setStatus(options.conversationId, "running");

    // Hold a concurrency slot for the actual LLM run (directives above are free).
    await runLimiter.run(
      () =>
        new Promise<void>((resolve) => {
          const translator = new Translator({ includeRawEvent: false });
          // Same messaging identity used for the GitHub-token lookup above — tags
          // the run's trace so the Astro Traces page attributes it to this user
          // (see ClaudeAgentSession.withUserTrace / the sandbox's own span).
          const source = useSandbox
            ? new SandboxSession({
                model,
                allowedTools: this.allowedTools,
                permissionMode: "acceptEdits",
                resumeSessionId: resume ?? undefined,
                githubToken,
                systemPromptAppend,
                workspaceKey: options.conversationId,
                repo: boundRepo ?? undefined,
                userId: options.userId,
              })
            : new ClaudeAgentSession({
                model,
                allowedTools: this.allowedTools,
                permissionMode: "acceptEdits",
                resumeSessionId: resume ?? undefined,
                githubToken,
                systemPromptAppend,
                cwd,
                userId: options.userId,
              });

          let settled = false;
          const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            this.registry?.setStatus(options.conversationId, "finished");
            if (hintUrl) {
              hooks.onChunk(`\n\n---\n💡 Tip: install me on your GitHub repos so I can read, push, and open PRs — ${hintUrl}`);
              void this.store.kvPut(HINT_NS, options.conversationId, "1");
            }
            hooks.onFinish();
            resolve();
          };
          const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            this.registry?.setStatus(options.conversationId, "errored");
            hooks.onError(err);
            resolve();
          };
          // A newer message in this thread (or an explicit Stop) aborts the signal;
          // kill the in-flight claude child and settle SILENTLY — this turn was
          // superseded, so emit no error/finish (the bridge drives the successor).
          function onAbort() {
            try {
              source.stop();
            } catch {
              /* best effort */
            }
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          }
          options.signal?.addEventListener("abort", onAbort, { once: true });

          source.on("event", (ev) => {
            if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
              void this.store.kvPut(CONV_NS, options.conversationId, ev.session_id);
            }
            for (const a of translator.handle(ev)) {
              // Mirror the full AG-UI stream into the registry for later review;
              // hooks below get only the subset Slack renders.
              this.registry?.append(options.conversationId, a);
              switch (a.type) {
                case EventType.TEXT_MESSAGE_CONTENT:
                  hooks.onChunk(a.delta);
                  break;
                case EventType.TOOL_CALL_START:
                  hooks.onStatusUpdate?.({ status: "PROCESSING", customMessage: `Using ${a.toolCallName}…`, emoji: "🔧" });
                  break;
                case EventType.RUN_FINISHED:
                  finish();
                  break;
                case EventType.RUN_ERROR:
                  fail(new Error(a.message));
                  break;
              }
            }
          });
          source.on("exit", () => finish());
          source.on("spawnError", (err) => fail(err));

          source.start();
          source.sendUserMessage(prompt);
          source.closeInput();
        }),
    );
  }
}
