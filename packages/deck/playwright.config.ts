/**
 * playwright.config.ts - Playwright E2E configuration.
 *
 * Boots the built React Router v7 app with env-injected temp fixture paths.
 *
 * The `pnpm e2e` script runs `node e2e/setup.mjs` BEFORE calling playwright.
 * setup.mjs creates the temp fixture dir and writes e2e/.e2e-env with:
 *   INBOX_ROOT, QUEUE_STATE_PATH, MC_SANDBOX_ONLY, MC_NOW, E2E_TEMP_ROOT
 *
 * The webServer command sources e2e/.e2e-env via bash e2e/start-server.sh.
 * start-server.sh waits briefly for the file then sources it and starts pnpm start.
 *
 * workers: 1 ensures tests run serially. All tests share one server and one temp
 * inbox dir. Parallel workers would cause beforeEach inbox resets to race with
 * other tests' write operations (compose, answer) on the same shared temp dir.
 *
 * reuseExistingServer is false: stale servers from previous runs have stale
 * (already-deleted) INBOX_ROOT temp paths and would fail all tests.
 *
 * ASCII only - no em-dashes per FND-05 (check:dashes gate).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/flows",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // Serial execution: all tests share one server + one temp inbox dir.
  // Parallel workers would cause beforeEach resets to race with write operations.
  workers: 1,
  use: {
    baseURL: "http://localhost:3917",
  },
  timeout: 30_000,
  webServer: {
    // Build first (no INBOX_ROOT needed for build), then start with env sourced.
    // e2e/.e2e-env is written by node e2e/setup.mjs (run before playwright starts).
    command: "pnpm build && bash e2e/start-server.sh",
    url: "http://localhost:3917",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: "3917",
    },
  },
});
