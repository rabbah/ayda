/**
 * Claude Code stream-json  ->  AG-UI event translator.
 *
 * Stateful, per-run. Feed it every stream-json event via `handle()`; it returns
 * zero or more AG-UI events to emit, in order. Pure with respect to I/O — it
 * neither reads stdin nor writes SSE; the caller owns transport. This keeps the
 * mapping unit-testable and lets telemetry/persistence subscribe to the same
 * source independently.
 *
 * Mapping summary (see README for the full table):
 *   system/init                          -> RUN_STARTED (+ STATE_SNAPSHOT of session meta)
 *   system/api_retry                     -> CUSTOM("claude.api_retry")
 *   stream_event content_block_start     -> TEXT_MESSAGE_START | TOOL_CALL_START | REASONING_MESSAGE_START
 *   stream_event content_block_delta     -> TEXT_MESSAGE_CONTENT | TOOL_CALL_ARGS | REASONING_MESSAGE_CONTENT
 *   stream_event content_block_stop      -> *_END for the open block at that index
 *   assistant (complete)                 -> fallback full triples IF not already streamed
 *   user (tool_result blocks)            -> TOOL_CALL_RESULT
 *   result success | error               -> RUN_FINISHED | RUN_ERROR
 *
 * Why partials drive text/tool-calls: `input_json_delta.partial_json` is a JSON
 * string fragment, which is EXACTLY what AG-UI `TOOL_CALL_ARGS.delta` expects —
 * a 1:1 map. The complete `assistant` event is used only as a fallback (when
 * `--include-partial-messages` is off) and to avoid double-emission otherwise.
 */

import { EventType, type AguiEvent } from "../types/agui.ts";
import type {
  AssistantEvent,
  ContentBlock,
  ResultEvent,
  StreamEventEvent,
  StreamJsonEvent,
  SystemApiRetryEvent,
  SystemInitEvent,
  ToolResultBlock,
  UserEvent,
} from "../types/streamjson.ts";

export interface TranslatorOptions {
  /** Injectable so runIds are deterministic in tests/demos. Default: random. */
  newRunId?: () => string;
  /** Attach the raw stream-json event as AG-UI `rawEvent`. Default true. */
  includeRawEvent?: boolean;
  /** Map Claude `thinking` -> REASONING_* (version-dependent). Default false. */
  emitReasoning?: boolean;
  /** Echo the replayed user prompt as a user-role TEXT_MESSAGE. Default false. */
  emitUserPrompt?: boolean;
}

type BlockKind = "text" | "tool" | "reasoning";
interface OpenBlock {
  kind: BlockKind;
  messageId?: string;
  toolCallId?: string;
}

export class Translator {
  private threadId: string | null = null;
  private runId: string | null = null;
  private model: string | null = null;
  private currentMessageId: string | null = null;
  private readonly streamedMessageIds = new Set<string>();
  private readonly openBlocks = new Map<number, OpenBlock>();
  private counter = 0;
  private readonly opts: Required<Omit<TranslatorOptions, "newRunId">> & {
    newRunId?: () => string;
  };

  constructor(opts: TranslatorOptions = {}) {
    this.opts = {
      includeRawEvent: opts.includeRawEvent ?? true,
      emitReasoning: opts.emitReasoning ?? false,
      emitUserPrompt: opts.emitUserPrompt ?? false,
      newRunId: opts.newRunId,
    };
  }

  /** The AG-UI threadId (== Claude session_id) once known. */
  get sessionThreadId(): string | null {
    return this.threadId;
  }
  get currentRunId(): string | null {
    return this.runId;
  }

  handle(ev: StreamJsonEvent): AguiEvent[] {
    let out: AguiEvent[];
    switch (ev.type) {
      case "system":
        out = this.onSystem(ev as SystemInitEvent | SystemApiRetryEvent);
        break;
      case "stream_event":
        out = this.onStreamEvent(ev);
        break;
      case "assistant":
        out = this.onAssistant(ev);
        break;
      case "user":
        out = this.onUser(ev);
        break;
      case "result":
        out = this.onResult(ev);
        break;
      default:
        out = [];
    }
    if (this.opts.includeRawEvent) for (const e of out) e.rawEvent = ev;
    return out;
  }

  private nextRunId(): string {
    return this.opts.newRunId ? this.opts.newRunId() : `run_${++this.counter}_${Date.now()}`;
  }

  private onSystem(ev: SystemInitEvent | SystemApiRetryEvent): AguiEvent[] {
    if (ev.subtype === "init") {
      this.threadId = ev.session_id;
      this.runId = this.nextRunId();
      this.model = ev.model ?? null;
      const started: AguiEvent = {
        type: EventType.RUN_STARTED,
        threadId: this.threadId,
        runId: this.runId,
      };
      // Surface session metadata as initial shared state for dashboard views.
      const snapshot: AguiEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          sessionId: ev.session_id,
          model: ev.model ?? null,
          cwd: ev.cwd ?? null,
          permissionMode: ev.permissionMode ?? null,
          tools: ev.tools ?? [],
          capabilities: ev.capabilities ?? [],
        },
      };
      return [started, snapshot];
    }
    if (ev.subtype === "api_retry") {
      // No native AG-UI event for transient retries — surface as CUSTOM.
      return [
        {
          type: EventType.CUSTOM,
          name: "claude.api_retry",
          value: {
            attempt: ev.attempt,
            maxRetries: ev.max_retries,
            retryDelayMs: ev.retry_delay_ms,
            errorStatus: ev.error_status,
            error: ev.error,
          },
        },
      ];
    }
    return [];
  }

  private onStreamEvent(ev: StreamEventEvent): AguiEvent[] {
    const inner = ev.event;
    switch (inner.type) {
      case "message_start": {
        this.currentMessageId = inner.message.id;
        this.streamedMessageIds.add(inner.message.id);
        return [];
      }
      case "content_block_start": {
        const cb = inner.content_block;
        if (cb.type === "text") {
          const messageId = this.currentMessageId ?? `msg_idx${inner.index}`;
          this.openBlocks.set(inner.index, { kind: "text", messageId });
          return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }];
        }
        if (cb.type === "tool_use") {
          this.openBlocks.set(inner.index, { kind: "tool", toolCallId: cb.id });
          return [
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: cb.id,
              toolCallName: cb.name,
              parentMessageId: this.currentMessageId ?? undefined,
            },
          ];
        }
        if (cb.type === "thinking" && this.opts.emitReasoning) {
          const messageId = this.currentMessageId ?? `msg_idx${inner.index}`;
          this.openBlocks.set(inner.index, { kind: "reasoning", messageId });
          return [{ type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" }];
        }
        return [];
      }
      case "content_block_delta": {
        const block = this.openBlocks.get(inner.index);
        if (!block) return [];
        const d = inner.delta;
        if (d.type === "text_delta" && block.kind === "text" && d.text.length > 0) {
          return [
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: block.messageId!, delta: d.text },
          ];
        }
        if (d.type === "input_json_delta" && block.kind === "tool") {
          // partial_json IS the AG-UI args JSON-string fragment. 1:1.
          return [
            { type: EventType.TOOL_CALL_ARGS, toolCallId: block.toolCallId!, delta: d.partial_json },
          ];
        }
        if (d.type === "thinking_delta" && block.kind === "reasoning") {
          return [
            {
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: block.messageId!,
              delta: d.thinking,
            },
          ];
        }
        return [];
      }
      case "content_block_stop": {
        const block = this.openBlocks.get(inner.index);
        if (!block) return [];
        this.openBlocks.delete(inner.index);
        if (block.kind === "text")
          return [{ type: EventType.TEXT_MESSAGE_END, messageId: block.messageId! }];
        if (block.kind === "tool")
          return [{ type: EventType.TOOL_CALL_END, toolCallId: block.toolCallId! }];
        if (block.kind === "reasoning")
          return [{ type: EventType.REASONING_MESSAGE_END, messageId: block.messageId! }];
        return [];
      }
      default:
        // message_delta (stop_reason/usage) & message_stop: telemetry-only, no AG-UI event.
        return [];
    }
  }

  /**
   * Complete assistant message. If we already streamed it via partials, skip
   * (usage is harvested by telemetry off the same event). Otherwise this is the
   * fallback path (`--include-partial-messages` disabled): emit full triples.
   */
  private onAssistant(ev: AssistantEvent): AguiEvent[] {
    const msg = ev.message;
    if (this.streamedMessageIds.has(msg.id)) return [];
    const out: AguiEvent[] = [];
    for (const block of msg.content) {
      out.push(...this.fullBlock(block, msg.id));
    }
    return out;
  }

  private fullBlock(block: ContentBlock, messageId: string): AguiEvent[] {
    if (block.type === "text") {
      return [
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: block.text },
        { type: EventType.TEXT_MESSAGE_END, messageId },
      ];
    }
    if (block.type === "tool_use") {
      return [
        { type: EventType.TOOL_CALL_START, toolCallId: block.id, toolCallName: block.name, parentMessageId: messageId },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: block.id, delta: JSON.stringify(block.input ?? {}) },
        { type: EventType.TOOL_CALL_END, toolCallId: block.id },
      ];
    }
    if (block.type === "thinking" && this.opts.emitReasoning) {
      return [
        { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: block.thinking },
        { type: EventType.REASONING_MESSAGE_END, messageId },
      ];
    }
    return [];
  }

  private onUser(ev: UserEvent): AguiEvent[] {
    const out: AguiEvent[] = [];
    const textParts: string[] = [];
    for (const block of ev.message.content) {
      if (block.type === "tool_result") {
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: ev.message.id,
          toolCallId: (block as ToolResultBlock).tool_use_id,
          content: stringifyToolContent((block as ToolResultBlock).content),
          role: "tool",
        });
      } else if (block.type === "text") {
        textParts.push(block.text);
      }
    }
    if (this.opts.emitUserPrompt && out.length === 0 && textParts.length > 0) {
      const messageId = ev.message.id;
      out.push(
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: textParts.join("") },
        { type: EventType.TEXT_MESSAGE_END, messageId },
      );
    }
    return out;
  }

  private onResult(ev: ResultEvent): AguiEvent[] {
    const threadId = this.threadId ?? ev.session_id;
    const runId = this.runId ?? "run_unknown";
    if (ev.is_error || ev.subtype === "error") {
      return [
        {
          type: EventType.RUN_ERROR,
          message: ev.error ?? ev.result ?? "Claude Code run failed",
          code: ev.stop_reason ?? ev.subtype,
        },
      ];
    }
    return [{ type: EventType.RUN_FINISHED, threadId, runId, result: ev.result }];
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // array of blocks, e.g. [{type:"text",text:"..."}]
    const texts = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : null))
      .filter((t): t is string => t !== null);
    if (texts.length) return texts.join("");
  }
  return JSON.stringify(content);
}
