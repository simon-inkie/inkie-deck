import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The concurrency suite launches 30 real OS processes that contend for a
    // single lock file, so it needs more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
