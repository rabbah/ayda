import { test, expect, type Page } from "@playwright/test";

/**
 * Stick-to-bottom: the timeline follows new content ONLY while the user is pinned
 * to the bottom (live-tailing). Once they scroll up to read history, new updates
 * must NOT yank them back down; scrolling back to the bottom re-arms it.
 *
 * This drives the real client render path — handle() dispatches an AG-UI event,
 * which appends a bubble and calls scroll(), exactly as the live SSE stream does.
 * We inject through window.handle via page.evaluate rather than mocking SSE so the
 * scroll position is fully deterministic (no streaming-timing flake).
 */

const BOTTOM_SLOP = 40; // px tolerance mirroring the client's atBottom() threshold

// Fill #timeline past its viewport so it becomes scrollable, feeding the same
// event dispatcher the SSE stream uses. `from`/`count` keep message ids unique
// across calls so a follow-up injection adds a distinct bubble.
async function inject(page: Page, from: number, count: number): Promise<void> {
  await page.evaluate(
    ({ from, count }) => {
      const w = window as unknown as { handle: (ev: unknown) => void };
      for (let i = from; i < from + count; i++) {
        const messageId = "m_" + i;
        w.handle({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        w.handle({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: `line ${i} — lorem ipsum dolor sit amet, filler text to give the bubble some height`,
        });
      }
    },
    { from, count },
  );
}

// Move the scroll position and fire a scroll event so the client's listener
// recomputes stickToBottom deterministically (no reliance on async scroll events).
async function scrollTo(page: Page, where: "top" | "bottom"): Promise<void> {
  await page.locator("#timeline").evaluate((el, where) => {
    el.scrollTop = where === "top" ? 0 : el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  }, where);
}

const scrollTop = (page: Page) => page.locator("#timeline").evaluate((el) => el.scrollTop);
const isPinned = (page: Page) =>
  page.locator("#timeline").evaluate(
    (el, slop) => el.scrollHeight - el.scrollTop - el.clientHeight < slop,
    BOTTOM_SLOP,
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await inject(page, 0, 40);
  // The test only means something if the timeline actually overflows its viewport.
  const scrollable = await page
    .locator("#timeline")
    .evaluate((el, slop) => el.scrollHeight > el.clientHeight + slop, BOTTOM_SLOP);
  expect(scrollable, "timeline should be scrollable after populating").toBe(true);
});

test("new updates do NOT scroll the user down while they read history", async ({ page }) => {
  await scrollTo(page, "top"); // user scrolls up -> stick-to-bottom disarms
  const before = await scrollTop(page);

  await inject(page, 40, 1); // a new streamed message arrives

  await expect(page.locator(".bubble.assistant")).toHaveCount(41); // it rendered...
  expect(await scrollTop(page)).toBe(before); // ...but the view stayed put
  expect(await isPinned(page)).toBe(false); // and did not jump to the bottom
});

test("new updates DO follow the bottom when the user is pinned there", async ({ page }) => {
  await scrollTo(page, "bottom"); // user is live-tailing -> stick stays armed
  await inject(page, 40, 1);

  await expect(page.locator(".bubble.assistant")).toHaveCount(41);
  expect(await isPinned(page)).toBe(true); // the view followed the new content
});
