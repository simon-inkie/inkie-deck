import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright specs live under e2e/ and run via `npm run e2e`, never
    // through vitest; the include glob above keeps the two suites apart.
  },
});
