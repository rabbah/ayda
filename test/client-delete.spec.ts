import { test, expect, type Route } from "@playwright/test";

/**
 * The session-history menu lets you delete a past session: clicking its ✕ issues
 * DELETE /sessions/:id, drops it from the per-browser history, and removes the row.
 * We mock the DELETE so the test is hermetic and can assert the request was made.
 */

const IDS = ["sess_del_a", "sess_del_b"];

test("deleting a session removes its row and calls DELETE /sessions/:id", async ({ page }) => {
  let deletedId: string | undefined;

  await page.route(/\/sessions\/[^/]+$/, async (route: Route) => {
    if (route.request().method() === "DELETE") {
      deletedId = new URL(route.request().url()).pathname.split("/").pop();
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });

  await page.addInitScript((ids) => {
    localStorage.setItem(
      "ada.sessions",
      JSON.stringify(ids.map((id, i) => ({ id, label: "session " + i, ts: i + 1 }))),
    );
  }, IDS);

  await page.goto("/");
  await page.locator("#sid-btn").click();
  await expect(page.locator(".sess-row")).toHaveCount(2);

  await page.locator(".sess-row").first().locator(".sess-del").click();

  await expect(page.locator(".sess-row")).toHaveCount(1);
  expect(deletedId && IDS.includes(deletedId)).toBeTruthy();
});
