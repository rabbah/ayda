/**
 * Persist the final `result` of each run for later billing/observability
 * queries — not just streamed to the client and discarded.
 *
 * Captures session_id, cost, usage, per-model breakdown, duration, turns, and
 * outcome. Interface + an in-memory and a JSONL-file impl for the scaffold;
 * swap for the platform's datastore later.
 */

import { appendFile } from "node:fs/promises";
import { computeCostUsd } from "../config/model.ts";
import type { ResultEvent } from "../types/streamjson.ts";

export interface RunRecord {
  sessionId: string;
  model: string | null;
  costUsd: number | null;
  costSource: "reported" | "computed" | "unknown";
  usage: ResultEvent["usage"] | null;
  modelUsage: ResultEvent["model_usage"] | null;
  numTurns: number | null;
  durationMs: number | null;
  stopReason: string | null;
  isError: boolean;
  finishedAt: string; // ISO
}

export function toRunRecord(model: string | null, ev: ResultEvent): RunRecord {
  const reported = ev.total_cost_usd ?? null;
  const computed = model ? computeCostUsd(model, ev.usage ?? {}) : null;
  return {
    sessionId: ev.session_id,
    model,
    costUsd: reported ?? computed,
    costSource: reported != null ? "reported" : computed != null ? "computed" : "unknown",
    usage: ev.usage ?? null,
    modelUsage: ev.model_usage ?? null,
    numTurns: ev.num_turns ?? null,
    durationMs: ev.duration_ms ?? null,
    stopReason: ev.stop_reason ?? null,
    isError: Boolean(ev.is_error),
    finishedAt: new Date().toISOString(),
  };
}

export interface ResultStore {
  save(record: RunRecord): Promise<void>;
}

export class InMemoryResultStore implements ResultStore {
  readonly records: RunRecord[] = [];
  async save(record: RunRecord): Promise<void> {
    this.records.push(record);
  }
}

export class JsonlFileResultStore implements ResultStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async save(record: RunRecord): Promise<void> {
    await appendFile(this.path, JSON.stringify(record) + "\n", "utf8");
  }
}
