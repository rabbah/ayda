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
import { Translator } from "../translate/translator.ts";
import { resolveModel } from "../config/model.ts";
import { EventType } from "../types/agui.ts";
import type { Store } from "../store/store.ts";
import { getValidToken } from "../auth/github-app.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getServerSecret, buildConnectUrl, buildSetupUrl } from "../auth/connect.ts";
import { isAdmin } from "../auth/setup.ts";

const CONV_NS = "conv_claude_session"; // conversationId -> claude session_id (for --resume)
const HINT_NS = "gh_connect_hint"; // conversationId -> "1" once the connect hint has been shown

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
    // context, so it runs before the DM gate. Handy for finding the value to put
    // in ADMIN_USER_IDS.
    if (directive.kind === "whoami") {
      const rec = githubConfigured() ? await this.store.getGithubToken(options.userId) : null;
      const gh = !githubConfigured()
        ? "not set up on this agent"
        : rec
          ? `connected as ${rec.githubLogin ?? "your account"}`
          : "not connected (run /connect-github)";
      reply(
        `Your messaging identity:\n` +
          `• userId: \`${options.userId}\`  (add this to ADMIN_USER_IDS to allow /setup-github)\n` +
          `• admin: ${isAdmin(options.userId) ? "yes" : "no"}\n` +
          `• github: ${gh}`,
      );
      return;
    }
    if (!isPrivate(options)) {
      reply(
        `Please DM me to ${directive.kind === "setup" ? "set up" : "connect"} GitHub — a link posted in a channel would be visible to everyone here.`,
      );
      return;
    }
    const secret = await getServerSecret(this.store);
    if (directive.kind === "connect") {
      if (!githubConfigured()) {
        reply("GitHub isn't set up on this agent yet, so there's nothing to connect to.");
        return;
      }
      reply(`Open this link and authorize to let me use your GitHub account (expires in 10 min):\n${buildConnectUrl(options.userId, secret)}`);
      return;
    }
    // setup — operator-only
    if (!isAdmin(options.userId)) {
      reply("You're not authorized to set up the GitHub App. Ask someone listed in ADMIN_USER_IDS to run /setup-github.");
      return;
    }
    const note = githubConfigured() ? "\n\n⚠️ This will replace the GitHub App currently configured." : "";
    reply(`Open this link to create the GitHub App and connect it (expires in 10 min):\n${buildSetupUrl(options.userId, secret, directive.org)}${note}`);
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
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (hintUrl) {
          hooks.onChunk(`\n\n---\n💡 Tip: connect your GitHub so I can act as you — ${hintUrl}`);
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
