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
 * TWO SERVERS, two projects. `flows` (3917) is the whole original suite,
 * unchanged. `layout` (3918) is the same build with an ACTIVITY_ROOT, so the
 * top-bar escalation alert renders and its header geometry can be measured at
 * real viewport widths. The alert's gate is read once at boot, so this could
 * not be a per-test toggle; see e2e/start-layout-server.sh.
 *
 * ASCII only - no em-dashes per FND-05 (check:dashes gate).
 */
import { defineConfig } from "@playwright/test";
import { BASE_URL, batchPrefsStorageState } from "./e2e/batch-prefs-state";

/** The activity-configured second instance. See e2e/start-layout-server.sh. */
const LAYOUT_BASE_URL = "http://localhost:3918";

export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // Serial execution: all tests share one server + one temp inbox dir.
  // Parallel workers would cause beforeEach resets to race with write operations.
  // Serial across PROJECTS too, which is what keeps the two servers below from
  // interleaving writes on roots they happen to share.
  workers: 1,
  use: {
    // Sending is effectively immediate for the whole suite. The composer's 18s
    // hold is a per-browser localStorage preference, so seeding it to the
    // minimum the app allows is a test-environment setting, not a product
    // change - batching stays on by default for users. It lives here rather
    // than in each spec so a new composer test inherits it instead of quietly
    // re-acquiring the 18s wait. See e2e/batch-prefs-state.ts for the
    // reasoning and for the E2E_HOLD_SECONDS revert-to-red knob.
    //
    // Kept at the top level, not moved onto the flows project: storageState is
    // keyed by origin, so the layout project (a different port) simply never
    // reads it, and leaving it here keeps "the suite default a new spec cannot
    // forget" true for any future project that DOES compose.
    storageState: batchPrefsStorageState(),
  },
  timeout: 30_000,
  projects: [
    {
      // Everything that existed before the layout project. Unchanged: same
      // testDir, same baseURL, same server.
      name: "flows",
      testDir: "./e2e/flows",
      use: { baseURL: BASE_URL },
    },
    {
      // Real-viewport header measurement, which needs the top-bar escalation
      // alert on screen and therefore needs an instance with an ACTIVITY_ROOT.
      // See e2e/start-layout-server.sh for why that cannot be the 3917
      // instance.
      name: "layout",
      testDir: "./e2e/layout",
      use: { baseURL: LAYOUT_BASE_URL },
    },
  ],
  webServer: [
    {
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
    {
      // Same build, activity-configured roots. Waits for 3917 rather than
      // running a second concurrent `pnpm build` into the same output dir.
      command: "bash e2e/start-layout-server.sh",
      url: LAYOUT_BASE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        PORT: "3918",
      },
    },
  ],
});
