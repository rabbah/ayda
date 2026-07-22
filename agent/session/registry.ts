/**
 * Per-session AG-UI event log — the backbone of lossless reconnect.
 *
 * The claude process and its event stream OUTLIVE any single client connection.
 * We assign every emitted AG-UI event a monotonic per-session sequence number
 * and retain it, so a client that reconnects with `Last-Event-ID: N` gets every
 * event with seq > N replayed, then joins the live tail. This is deliberately
 * decoupled from transport: the registry knows nothing about SSE or HTTP.
 *
 * (This is the same "list history -> dedupe -> tail live" pattern Anthropic's
 * Managed Agents client uses; here we own the history store.)
 *
 * SCAFFOLD NOTE: the log is in-memory and unbounded. Before production, cap it
 * (ring buffer + spill to disk/Redis) and add TTL/GC on terminated sessions.
 */

import { EventEmitter } from "node:events";
import type { AguiEvent } from "../types/agui.ts";

export interface LoggedEvent {
  seq: number;
  event: AguiEvent;
}

export type SessionStatus = "starting" | "running" | "finished" | "errored";

interface SessionState {
  sessionId: string;
  seq: number;
  log: LoggedEvent[];
  status: SessionStatus;
  emitter: EventEmitter; // "event" (LoggedEvent), "status" (SessionStatus)
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();

  ensure(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        seq: 0,
        log: [],
        status: "starting",
        emitter: new EventEmitter(),
      });
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Drop a session and its event log. Any still-open SSE connection stops
   * receiving new events (its subscription is detached); the client sees the
   * stream go quiet. Returns false if the session was already gone.
   */
  delete(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.emitter.removeAllListeners();
    return this.sessions.delete(sessionId);
  }

  /** Append an emitted AG-UI event; returns it with its assigned seq. */
  append(sessionId: string, event: AguiEvent): LoggedEvent {
    const s = this.get(sessionId);
    const logged: LoggedEvent = { seq: ++s.seq, event };
    s.log.push(logged);
    s.emitter.emit("event", logged);
    return logged;
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.get(sessionId);
    s.status = status;
    s.emitter.emit("status", status);
  }

  status(sessionId: string): SessionStatus {
    return this.get(sessionId).status;
  }

  /** Replay buffer: every event with seq > lastSeq (lastSeq < 0 => all). */
  since(sessionId: string, lastSeq: number): LoggedEvent[] {
    const s = this.get(sessionId);
    if (lastSeq < 0) return [...s.log];
    return s.log.filter((e) => e.seq > lastSeq);
  }

  /**
   * Subscribe to live events after a given seq. Returns an unsubscribe fn.
   * Caller is responsible for first draining `since()` and de-duping by seq to
   * avoid a race with events appended between the two calls.
   */
  subscribe(sessionId: string, onEvent: (e: LoggedEvent) => void): () => void {
    const s = this.get(sessionId);
    s.emitter.on("event", onEvent);
    return () => s.emitter.off("event", onEvent);
  }

  private get(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    return s;
  }
}
