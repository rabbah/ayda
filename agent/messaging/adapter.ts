/**
 * Astro messaging AgentAdapter for Claude Code.
 *
 * Lets the platform's messaging sidecar (web / Slack / …) converse with Claude
 * Code: the sidecar hands us a normalized message per interaction; we run a
 * Claude Code session and stream the response back through the hooks.
 *
 * We reuse the existing pipeline: ClaudeAgentSession (SDK query) -> Translator
 * (SDK/stream-json -> AG-UI) -> map AG-UI events onto the messaging hooks. So the
 * same, tested mapping drives both the SSE/AG-UI frontend and Slack.
 *
 * Conversation continuity: `options.conversationId` (a Slack thread, a web chat)
 * is mapped to a Claude session_id in the Store, and passed back as `--resume`
 * on the next turn — so a Slack thread is one continuous Claude conversation.
 *
 * `@astropods/adapter-core` types are imported type-only (erased at runtime), so
 * this module loads without the package present; `serve()` is dynamically
 * imported in index.ts only when the messaging sidecar is attached.
 */

import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import { ClaudeAgentSession } from "../claude/agent.ts";
import { ensureWorkspace } from "../session/workspace.ts";
import { Translator } from "../translate/translator.ts";
import { resolveModel } from "../config/model.ts";
import { EventType } from "../types/agui.ts";
import type { Store } from "../store/store.ts";
import { getValidToken } from "../auth/github-app.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getServerSecret, buildConnectUrl } from "../auth/connect.ts";

const CONV_NS = "conv_claude_session"; // conversationId -> claude session_id (for --resume)
const HINT_NS = "gh_connect_hint"; // conversationId -> "1" once the connect hint has been shown
const WS_NS = "conv_workspace"; // conversationId -> workspace path (reused across resumed turns)

type Directive = { kind: "connect" } | { kind: "setup"; org?: string } | { kind: "whoami" };

/** Parse a whole-message GitHub directive, or null if the message isn't one. */
function parseDirective(prompt: string): Directive | null {
  const t = prompt.trim();
  const lower = t.toLowerCase().replace(/^\//, "");
  if (lower === "whoami") return { kind: "whoami" };
  if (lower === "connect-github" || lower === "connect github") return { kind: "connect" };
  const m = t.match(/^\/?setup-github(?:\s+(\S+))?\s*$/i);
  if (m) return { kind: "setup", org: m[1] };
  return null;
}

/**
 * Whether the conversation is private: a Slack DM, or a non-platform web/
 * playground session (no platformContext, inherently 1:1). Connect/setup links
 * must only be handed out here — in a shared channel anyone could click one
 * within its TTL and bind their own GitHub to this user's identity.
 */
function isPrivate(options: StreamOptions): boolean {
  const ctx = options.platformContext as { eventKind?: string } | undefined;
  return !ctx || ctx.eventKind === "EVENT_KIND_DM";
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "Ayda";
  private readonly store: Store;
  private readonly allowedTools: string[];

  constructor(store: Store, allowedTools: string[] = ["Read", "Edit", "Bash", "Grep"]) {
    this.store = store;
    this.allowedTools = allowedTools;
  }

  getConfig() {
    return {
      systemPrompt: "Claude Code (claude_code system-prompt preset)",
      tools: this.allowedTools.map((name) => ({ name })),
    };
  }

  /** Handle a GitHub directive: validate context/authorization, reply with a link. */
  private async runDirective(directive: Directive, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    const reply = (msg: string) => {
      hooks.onChunk(msg);
      hooks.onFinish();
    };
    // whoami reveals only the caller's own identity to themselves — safe in any
    // context, so it runs before the DM gate.
    if (directive.kind === "whoami") {
      const rec = githubConfigured() ? await this.store.getGithubToken(options.userId) : null;
      const gh = !githubConfigured()
        ? "not set up on this agent"
        : rec
          ? `connected as ${rec.githubLogin ?? "your account"}`
          : "not connected (run /connect-github)";
      reply(
        `Your messaging identity:\n` +
          `• userId: \`${options.userId}\`\n` +
          `• github: ${gh}`,
      );
      return;
    }
    // Setup is web-only: provisioning is gated on the ALB-verified web identity
    // (admin email when ADMIN_EMAILS is set, otherwise any signed-in user), which
    // the messaging surface doesn't carry. Point operators to the web UI — this is
    // just guidance (no link), so it's safe in any context.
    if (directive.kind === "setup") {
      reply(
        `GitHub App setup moved to the web UI. Open the app and click "Set up GitHub App". ` +
          `Chat can't run setup — it needs your signed-in web identity, which isn't available here.`,
      );
      return;
    }
    // connect — DM-only: the link binds to your identity, so a channel would leak it.
    if (!isPrivate(options)) {
      reply(`Please DM me to connect GitHub — a link posted in a channel would be visible to everyone here.`);
      return;
    }
    if (!githubConfigured()) {
      reply("GitHub isn't set up on this agent yet, so there's nothing to connect to.");
      return;
    }
    const secret = await getServerSecret(this.store);
    reply(`Open this link to install me on the repositories you want me to work with — you pick the repos, and it connects your GitHub in the same step (expires in 10 min):\n${buildConnectUrl(options.userId, secret)}`);
  }

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    // GitHub directives (/whoami, /connect-github, /setup-github) short-circuit
    // the run. connect/setup are DM-only and hand back a signed link (setup is
    // also admin-only); whoami just reports the caller's identity.
    const directive = parseDirective(prompt);
    if (directive) {
      await this.runDirective(directive, hooks, options);
      return;
    }

    const model = resolveModel();
    const resume = (await this.store.kvGet(CONV_NS, options.conversationId)) as string | null;

    // Persist one writable workspace per conversation (reused across resumed
    // turns), keyed the same way as the resume mapping. On container restart the
    // temp dir is gone even though --resume survives; ensureWorkspace recreates
    // an empty dir so the run still works (files from prior turns are lost).
    const storedWs = (await this.store.kvGet(WS_NS, options.conversationId)) as string | null;
    const cwd = ensureWorkspace(storedWs);
    if (cwd !== storedWs) await this.store.kvPut(WS_NS, options.conversationId, cwd);

    // Per-user GitHub token, keyed by the messaging identity (options.userId).
    // Injected as GH_TOKEN so git/gh in the Claude child act as this user —
    // the frontend /sessions path does the same, keyed by bridge_uid instead.
    const githubToken = githubConfigured()
      ? ((await getValidToken(this.store, options.userId)) ?? undefined)
      : undefined;

    // GitHub is available but this user hasn't connected: show a one-time hint
    // per conversation (precomputed here so finish() can emit it synchronously).
    let hintUrl: string | null = null;
    if (githubConfigured() && !githubToken && !(await this.store.kvGet(HINT_NS, options.conversationId))) {
      hintUrl = buildConnectUrl(options.userId, await getServerSecret(this.store));
    }

    const translator = new Translator({ includeRawEvent: false });
    const source = new ClaudeAgentSession({
      model,
      allowedTools: this.allowedTools,
      permissionMode: "acceptEdits",
      resumeSessionId: resume ?? undefined,
      githubToken,
      cwd,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
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
        hooks.onError(err);
        resolve();
      };

      source.on("event", (ev) => {
        // Persist conversation -> claude session for continuity (--resume next turn).
        if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
          void this.store.kvPut(CONV_NS, options.conversationId, ev.session_id);
        }
        for (const a of translator.handle(ev)) {
          switch (a.type) {
            case EventType.TEXT_MESSAGE_CONTENT:
              hooks.onChunk(a.delta);
              break;
            case EventType.TOOL_CALL_START:
              hooks.onStatusUpdate?.({
                status: "PROCESSING",
                customMessage: `Using ${a.toolCallName}…`,
                emoji: "🔧",
              });
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
    });
  }
}
