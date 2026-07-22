import { test, expect } from "@playwright/test";
import http from "node:http";

/**
 * Server-side counterparts to the client tests, using the test-only POST /test/seed
 * hook (AYDA_TEST_HOOKS=1) to build a finished, replayable session without a model
 * call. Covers the resume-precedence fix (Last-Event-ID header beats the sticky
 * ?lastEventId query) and the DELETE /sessions/:id semantics.
 */

const BASE = `http://localhost:${process.env.PORT ?? 8123}`;

/** Open an SSE connection, collect the initial replay burst, then tear it down.
 *  (The endpoint stays open with heartbeats, so we can't await the full body.) */
function collectSse(path: string, headers: Record<string, string>, ms = 700): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c.toString()));
      const timer = setTimeout(() => {
        req.destroy();
        resolve(buf);
      }, ms);
      res.on("end", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    req.on("error", reject);
  });
}

test("SSE resume prefers the Last-Event-ID header over the ?lastEventId query", async ({ request }) => {
  const seed = await (await request.post("/test/seed")).json();
  expect(seed.lastSeq).toBeGreaterThan(10);

  // Header (10) must win over the sticky query (-1): only seq > 10 replay. This is
  // the exact reconnect scenario — a stale ?lastEventId=-1 in the URL plus a live
  // Last-Event-ID header — that previously re-replayed the whole log.
  const resumed = await collectSse(`/sessions/${seed.sessionId}/events?lastEventId=-1`, {
    "Last-Event-ID": "10",
  });
  expect(resumed).toContain("id: 11");
  expect(resumed).toContain(`id: ${seed.lastSeq}`);
  expect(resumed).not.toMatch(/\bid: 1\n/);
  expect(resumed).not.toMatch(/\bid: 10\n/);

  // Control: a fresh connection with no header replays everything (id: 1 present).
  const full = await collectSse(`/sessions/${seed.sessionId}/events?lastEventId=-1`, {});
  expect(full).toMatch(/\bid: 1\n/);
});

test("DELETE /sessions/:id drops the session (204, then 404) and events 404 afterwards", async ({ request }) => {
  const seed = await (await request.post("/test/seed")).json();

  expect((await request.delete(`/sessions/${seed.sessionId}`)).status()).toBe(204);
  expect((await request.delete(`/sessions/${seed.sessionId}`)).status()).toBe(404);
  expect((await request.get(`/sessions/${seed.sessionId}/events`)).status()).toBe(404);
});

test("POST /test/seed returns a finished, replayable session", async ({ request }) => {
  const res = await request.post("/test/seed");
  expect(res.status()).toBe(201);
  const seed = await res.json();
  expect(seed.sessionId).toMatch(/^sess_seed_/);
  expect(seed.lastSeq).toBe(23); // the recorded fixture yields 23 AG-UI events
});
