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

const CONV_NS = "conv_claude_session"; // conversationId -> claude session_id (for --resume)

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "Ada";
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

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    const model = resolveModel();
    const resume = (await this.store.kvGet(CONV_NS, options.conversationId)) as string | null;
    const translator = new Translator({ includeRawEvent: false });
    const source = new ClaudeAgentSession({
      model,
      allowedTools: this.allowedTools,
      permissionMode: "acceptEdits",
      resumeSessionId: resume ?? undefined,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
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
