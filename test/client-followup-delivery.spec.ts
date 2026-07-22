import { test, expect, type Route } from "@playwright/test";

/**
 * Bug: a follow-up turn's events reach the registry but not the live browser, so
 * the UI hangs on "Claude is thinking…" until a manual refresh replays them.
 *
 * Cause: the follow-up path assumed the existing SSE was still open, but a proxy
 * can silently drop an idle stream half-open (readyState stays OPEN, no reconnect
 * fires) — so the turn streams into a dead socket. The fix re-establishes the SSE
 * on follow-up submit (resuming from lastEventId; dedupe keeps it gap-free).
 *
 * This reproduces it deterministically: the events mock serves turn 1 to the
 * initial connection and turn 2 ONLY to a reconnection that resumes past turn 1.
 * A finite fulfilled response closes the stream (the "dropped SSE"), and the huge
 * retry stops the browser from auto-reconnecting — so turn 2 is delivered ONLY if
 * the app proactively reconnects on submit. Without the fix, this test hangs/fails.
 */

const SESSION_ID = "sess_followup_test";

const frame = (id: number, ev: object) => `id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`;

// retry:100000 (100s) => finite responses below won't trigger a browser
// auto-reconnect during the test; only the app's own connect() calls do.
const TURN1 =
  "retry: 100000\n\n" +
  frame(1, { type: "RUN_STARTED", threadId: SESSION_ID, runId: "run_1" }) +
  frame(2, { type: "STATE_SNAPSHOT", snapshot: { sessionId: SESSION_ID, model: "m", tools: ["Read"] } }) +
  frame(3, { type: "RUN_FINISHED", threadId: SESSION_ID, runId: "run_1", result: "turn 1 done" });

const TURN2 =
  "retry: 100000\n\n" +
  frame(4, { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" }) +
  frame(5, { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "follow-up reply" }) +
  frame(6, { type: "TEXT_MESSAGE_END", messageId: "m2" }) +
  frame(7, { type: "RUN_FINISHED", threadId: SESSION_ID, runId: "run_2", result: "turn 2 done" });

test("a follow-up turn's events are delivered even after the prior SSE goes dead", async ({ page }) => {
  await page.route(/\/sessions\/[^/]+\/events/, async (route: Route) => {
    // Initial connect uses ?lastEventId=-1 (full replay); the follow-up reconnect
    // resumes from the last seq seen (?lastEventId=3). Serve the matching turn.
    const q = new URL(route.request().url()).searchParams.get("lastEventId");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: q === "-1" ? TURN1 : TURN2,
    });
  });
  await page.route(/\/sessions\/[^/]+\/messages$/, (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ sessionId: SESSION_ID }) }),
  );

  await page.addInitScript((id) => {
    localStorage.setItem("ada.sessions", JSON.stringify([{ id, label: "followup test", ts: 1 }]));
  }, SESSION_ID);

  await page.goto("/");
  await page.locator("#sid-btn").click();
  await page.locator(".sess-row .sess-item").first().click(); // switchSession -> connect(-1) -> turn 1
  await expect(page.locator(".final")).toHaveCount(1); // turn 1 finished

  // Follow-up: the old SSE is dead. Without the fix, these events never arrive.
  await page.locator("#prompt").fill("continue please");
  await page.locator("#send").click();

  // Turn 2's reply + finished marker appear WITHOUT a manual refresh.
  await expect(page.locator(".bubble.assistant .body")).toContainText("follow-up reply");
  await expect(page.locator(".final")).toHaveCount(2);
});
