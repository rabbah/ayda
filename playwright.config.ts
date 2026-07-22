import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Ayda bridge e2e tests.
 *
 * The server (`node agent/index.ts`) has NO external runtime dependencies — every
 * external package (the Claude SDK, pg, OTel) is dynamically imported and guarded,
 * so the process boots on Node alone. We launch it here with AYDA_TEST_HOOKS=1 so
 * the test-only POST /test/seed route (which seeds a replayable session from the
 * recorded fixture — no model call) is available.
 *
 * Tests cover the SSE reconnect fix (client dedupe + Last-Event-ID resume) and the
 * session-delete feature — none of which need a real Claude run or a credential.
 */
const PORT = Number(process.env.PORT ?? 8123);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "test",
  fullyParallel: false, // one shared server + registry; keep specs deterministic
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node agent/index.ts",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: String(PORT), AYDA_TEST_HOOKS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  },
});
