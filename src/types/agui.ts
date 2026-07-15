/**
 * AG-UI protocol event types.
 *
 * These mirror the canonical Zod schemas in `@ag-ui/core`
 * (`sdks/typescript/packages/core/src/events.ts`). We keep local types so the
 * translator has zero runtime deps and the demo runs anywhere, but the intent
 * is to PIN `@ag-ui/core` and validate emitted events against its Zod schemas
 * in CI (see README "Pin list"). Field names/shapes here are taken verbatim
 * from that source — do not "improve" them.
 *
 * Discriminator is `type` (UPPER_SNAKE). Every event may carry BaseEvent's
 * optional `timestamp` (epoch ms) and `rawEvent` (the original upstream event).
 */

export const EventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  // Reasoning family is version-dependent (THINKING_* was removed in AG-UI 1.0.0
  // in favour of REASONING_*). Off by default in the translator. See pin list.
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  RAW: "RAW",
  CUSTOM: "CUSTOM",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface BaseEvent {
  type: EventType;
  /** epoch ms; optional per BaseEvent. */
  timestamp?: number;
  /** original upstream (Claude stream-json) event, for debugging/lossless passthrough. */
  rawEvent?: unknown;
}

export type Role = "developer" | "system" | "assistant" | "user";

export interface RunStartedEvent extends BaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface RunFinishedEvent extends BaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
  // `outcome` is a newer, optional field; omitted here for legacy-safety. See pin list.
}

export interface RunErrorEvent extends BaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}

export interface TextMessageStartEvent extends BaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: Role; // defaults to "assistant" upstream; NOT "tool"
  name?: string;
}

export interface TextMessageContentEvent extends BaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string; // non-empty text chunk
}

export interface TextMessageEndEvent extends BaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string; // NB: `toolCallName`, not `name`
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string; // JSON string FRAGMENT — concatenate all deltas to rebuild the args object
}

export interface ToolCallEndEvent extends BaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface ToolCallResultEvent extends BaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string; // plain string
  role?: "tool";
}

export interface StateSnapshotEvent extends BaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: unknown; // full state object
}

export interface StateDeltaEvent extends BaseEvent {
  type: "STATE_DELTA";
  delta: unknown[]; // array of RFC 6902 JSON Patch ops
}

export interface ReasoningMessageStartEvent extends BaseEvent {
  type: "REASONING_MESSAGE_START";
  messageId: string;
  role: "reasoning";
}
export interface ReasoningMessageContentEvent extends BaseEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface ReasoningMessageEndEvent extends BaseEvent {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}

export interface CustomEvent extends BaseEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | CustomEvent;
