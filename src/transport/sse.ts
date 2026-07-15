/**
 * AG-UI over Server-Sent Events.
 *
 * AG-UI's own encoder frames each event as `data: {json}\n\n` with NO `event:`
 * line — the kind lives in the JSON `type`. We keep that exact body framing so
 * any AG-UI-compatible client (CopilotKit, etc.) parses it unchanged.
 *
 * We ADD one thing the base AG-UI SSE transport omits: an `id:` line carrying
 * our per-session sequence number, so the browser's EventSource sends
 * `Last-Event-ID` on reconnect and we can replay the gap from the registry.
 * The `id:` line is valid SSE and ignored by clients that don't use it — but it
 * IS a bridge-specific extension to the AG-UI transport. See README pin list.
 */

import type { AguiEvent } from "../types/agui.ts";
import type { LoggedEvent } from "../session/registry.ts";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable proxy buffering (nginx) so events flush immediately.
  "X-Accel-Buffering": "no",
} as const;

/** One SSE frame. `seq` becomes the SSE `id:` (our reconnect cursor). */
export function sseFrame(seq: number, event: AguiEvent): string {
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Frame with no id (pure AG-UI compatibility, e.g. for non-reconnecting sinks). */
export function sseFrameNoId(event: AguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** SSE comment line — keep-alive heartbeat; ignored by clients. */
export function sseHeartbeat(): string {
  return `: keep-alive\n\n`;
}

/** Parse the reconnect cursor from the `Last-Event-ID` header. -1 if absent. */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return -1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : -1;
}

export function frameLogged(logged: LoggedEvent): string {
  return sseFrame(logged.seq, logged.event);
}
