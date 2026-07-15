/**
 * Demo: feed the recorded `read -> edit -> report` stream-json fixture through
 * the translator and print the AG-UI events it produces — with the exact SSE
 * framing a client would receive. No API key, no network, no frontend.
 *
 *   node scripts/demo-translate.ts            # AG-UI event list + SSE frames
 *   node scripts/demo-translate.ts --sse      # SSE frames only (paste-able)
 *
 * Deterministic: runIds come from an injected counter so output is stable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Translator } from "../src/translate/translator.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import { sseFrame } from "../src/transport/sse.ts";
import { computeCostUsd } from "../src/config/model.ts";
import type { StreamJsonEvent, ResultEvent } from "../src/types/streamjson.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "read-edit-report.streamjson.jsonl");
const sseOnly = process.argv.includes("--sse");

const lines = readFileSync(fixturePath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

// Deterministic runId, and don't clutter payloads with rawEvent for the demo.
let runCounter = 0;
const translator = new Translator({
  newRunId: () => `run_${++runCounter}`,
  includeRawEvent: false,
});
const registry = new SessionRegistry();

let resultEvent: ResultEvent | null = null;
const aguiEvents: Array<{ seq: number; event: unknown }> = [];

for (const line of lines) {
  const sj = JSON.parse(line) as StreamJsonEvent;
  if (sj.type === "result") resultEvent = sj;

  for (const ev of translator.handle(sj)) {
    const sessionId = translator.sessionThreadId ?? "pending";
    registry.ensure(sessionId);
    const logged = registry.append(sessionId, ev);
    aguiEvents.push({ seq: logged.seq, event: ev });

    if (sseOnly) {
      process.stdout.write(sseFrame(logged.seq, ev));
    }
  }
}

if (sseOnly) process.exit(0);

console.log("=".repeat(72));
console.log("AG-UI events produced from read -> edit -> report (in order)");
console.log("=".repeat(72));
for (const { seq, event } of aguiEvents) {
  console.log(`#${String(seq).padStart(2, "0")}  ${JSON.stringify(event)}`);
}

console.log("\n" + "=".repeat(72));
console.log("Sample SSE wire frames (first 6) — exactly what the client reads");
console.log("=".repeat(72));
for (const { seq, event } of aguiEvents.slice(0, 6)) {
  // eslint-disable-next-line no-control-regex
  process.stdout.write(sseFrame(seq, event as never));
}

console.log("=".repeat(72));
console.log("Billing / telemetry summary (from the final `result` event)");
console.log("=".repeat(72));
if (resultEvent) {
  const reported = resultEvent.total_cost_usd ?? null;
  const computed = computeCostUsd("claude-opus-4-8", resultEvent.usage ?? {});
  console.log("reported total_cost_usd :", reported);
  console.log("computed from usage×price:", computed, "(fallback / gateway basis)");
  console.log("usage                   :", JSON.stringify(resultEvent.usage));
  console.log("model_usage             :", JSON.stringify(resultEvent.model_usage));
}
console.log(`\ntotal AG-UI events: ${aguiEvents.length}`);
