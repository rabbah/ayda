/**
 * Inbound transport abstraction — how the initial prompt (and follow-up turns)
 * reach the bridge. HTTP and message-queue are both scaffolded behind one
 * interface so we can pick later without touching supervisor/translator.
 *
 * Outbound (AG-UI events -> client) is always SSE (see transport/sse.ts); this
 * interface is only about INBOUND prompts.
 */

export interface PromptRequest {
  /** Existing Claude session to resume, or undefined to start a new one. */
  sessionId?: string;
  prompt: string;
  allowedTools?: string[];
  permissionMode?: string;
  metadata?: Record<string, unknown>;
}

export interface StartedSession {
  sessionId: string;
}

export type PromptHandler = (req: PromptRequest) => Promise<StartedSession>;

export interface PromptTransport {
  /** Register the handler that starts/continues a Claude session. */
  onPrompt(handler: PromptHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * HTTP transport stub. Real impl: POST /sessions {prompt,...} -> {sessionId};
 * POST /sessions/:id/messages for follow-ups. GET SSE lives in index.ts.
 */
export class HttpPromptTransport implements PromptTransport {
  private handler: PromptHandler | null = null;
  private readonly port: number;
  constructor(port: number) {
    this.port = port;
  }
  onPrompt(handler: PromptHandler): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    if (!this.handler) throw new Error("no prompt handler registered");
    // TODO: mount routes on the shared http.Server created in index.ts.
    void this.port;
  }
  async stop(): Promise<void> {}
}

/**
 * Message-queue transport stub (e.g. the Astropods workload queue). Real impl:
 * subscribe to a topic, each message is a PromptRequest, ack after the session
 * is started (not after it finishes — the run outlives the message).
 */
export class QueuePromptTransport implements PromptTransport {
  private handler: PromptHandler | null = null;
  private readonly topic: string;
  constructor(topic: string) {
    this.topic = topic;
  }
  onPrompt(handler: PromptHandler): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    if (!this.handler) throw new Error("no prompt handler registered");
    void this.topic;
  }
  async stop(): Promise<void> {}
}
