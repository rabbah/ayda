/**
 * Claude Code `--output-format stream-json` (NDJSON) event types.
 *
 * Derived from the Claude Code headless docs + CLI behaviour. Everything here
 * is VERSION-DEPENDENT on the `claude` binary — feature-detect via the
 * `system/init` event's `capabilities[]` array rather than a version string,
 * and pin the CLI version in the container image. See README "Pin list".
 *
 * We type only the fields the bridge consumes; unknown fields are tolerated.
 */

/* ---------- Anthropic content blocks (as they appear inside messages) ---------- */

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown; // string | array of blocks | object
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/* ---------- Top-level stream-json events ---------- */

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  capabilities?: string[];
  uuid?: string;
}

export interface SystemApiRetryEvent {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  uuid?: string;
  session_id?: string;
}

export interface SystemOtherEvent {
  type: "system";
  subtype: string;
  [k: string]: unknown;
}

export interface AssistantEvent {
  type: "assistant";
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    id: string;
    role: "assistant";
    model?: string;
    content: ContentBlock[];
    usage?: TokenUsage;
  };
}

export interface UserEvent {
  type: "user";
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    id: string;
    role: "user";
    content: ContentBlock[];
  };
}

/* stream_event wraps the raw Anthropic Messages streaming events (partials). */
export interface StreamEventEvent {
  type: "stream_event";
  session_id: string;
  uuid?: string;
  event: RawStreamInner;
}

export type RawStreamInner =
  | { type: "message_start"; message: { id: string; role: "assistant"; model?: string } }
  | { type: "content_block_start"; index: number; content_block: ContentBlockStart }
  | { type: "content_block_delta"; index: number; delta: ContentDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: Partial<TokenUsage> }
  | { type: "message_stop" };

export type ContentBlockStart =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: "thinking"; thinking?: string };

export type ContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string };

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error" | "completion" | string;
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  stop_reason?: string;
  usage?: TokenUsage;
  model_usage?: Record<string, TokenUsage & { cost_usd?: number }>;
  permission_denials?: unknown[];
  error?: string | null;
  uuid?: string;
}

export type StreamJsonEvent =
  | SystemInitEvent
  | SystemApiRetryEvent
  | SystemOtherEvent
  | AssistantEvent
  | UserEvent
  | StreamEventEvent
  | ResultEvent;

/* ---------- Input (stdin) NDJSON we WRITE to claude ---------- */

export interface UserInputMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
}
