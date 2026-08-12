import { defineConfig } from "@playwright/test";

// Harness only for now: there is no UI in this slice, so there is nothing
// real to drive. The config exists (and CI runs it) so that the first real
// UI test lands into working plumbing rather than having to build it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    // No baseURL yet: nothing serves. The first UI slice adds a webServer
    // block here pointing at the deck dev server.
    trace: "on-first-retry",
  },
});
