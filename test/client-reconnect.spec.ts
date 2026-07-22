import { test, expect, type Route } from "@playwright/test";

/**
 * The bug: behind a proxy that tears down the SSE stream, the browser reconnects
 * every few seconds and the server re-replayed the whole buffer, which the client
 * re-rendered — so a finished session's "state: …" / "✓ finished" piled up forever.
 *
 * This drives that exact scenario deterministically by MOCKING the SSE endpoint:
 * each fulfilled (finite) response makes EventSource reconnect, and we re-serve the
 * whole buffer on the reconnect (simulating a -1 full replay). The client fix under
 * test is the de-dupe: "✓ finished" must render exactly ONCE no matter how many
 * times the buffer is re-replayed.
 *
 * (The other half of the fix — the server honouring Last-Event-ID over the sticky
 * ?lastEventId query on reconnect — is covered in server-sse.spec.ts with a real
 * resume header; Chromium's reconnect header isn't reliably observable through
 * route mocking, and it's browser behaviour rather than ours anyway.)
 */

const SESSION_ID = "sess_reconnect_test";

// A minimal AG-UI buffer with id: lines. STATE_SNAPSHOT renders a "state: …" note;
// RUN_FINISHED renders a ".final" ✓ finished. retry:100 => fast reconnect.
const SSE_BODY =
  "retry: 100\n\n" +
  `id: 1\ndata: ${JSON.stringify({ type: "RUN_STARTED", threadId: SESSION_ID, runId: "run_1" })}\n\n` +
  `id: 2\ndata: ${JSON.stringify({ type: "STATE_SNAPSHOT", snapshot: { sessionId: SESSION_ID, model: "claude-opus-4-8", tools: ["Read"] } })}\n\n` +
  `id: 3\ndata: ${JSON.stringify({ type: "RUN_FINISHED", threadId: SESSION_ID, runId: "run_1", result: "done" })}\n\n`;

test("SSE reconnect re-replays but the client does not duplicate the timeline", async ({ page }) => {
  let calls = 0;

  await page.route(/\/sessions\/[^/]+\/events/, async (route: Route) => {
    calls += 1;
    // After two full replays, stop the loop with a 404 so EventSource goes CLOSED
    // (no more reconnects) and the assertions run against a settled timeline.
    if (calls >= 3) return route.fulfill({ status: 404, body: "gone" });
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: SSE_BODY,
    });
  });

  // Seed one session into the per-browser history before the app boots.
  await page.addInitScript((id) => {
    localStorage.setItem("ada.sessions", JSON.stringify([{ id, label: "reconnect test", ts: 1 }]));
  }, SESSION_ID);

  await page.goto("/");
  await page.locator("#sid-btn").click();
  await page.locator(".sess-row .sess-item").first().click(); // switchSession -> connect(-1)

  // Wait for the initial replay + at least one reconnect (each fulfill closes,
  // so EventSource re-requests and re-replays the same buffer).
  await expect.poll(() => calls, { timeout: 5000 }).toBeGreaterThanOrEqual(2);

  // Despite two full-buffer replays, the finished marker renders exactly once.
  await expect(page.locator(".final")).toHaveCount(1);
  await expect(page.locator(".final")).toHaveText("✓ finished");
});
