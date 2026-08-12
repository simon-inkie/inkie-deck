import { defineConfig } from "vitest/config";

// Root vitest config exists for one reason: `npx vitest run` at the repo root
// is what a newcomer types, and without this it walks the whole tree, picks up
// the Playwright specs under e2e/, and fails with "Playwright Test did not
// expect test() to be called here". The suite is green, the command is red, and
// the first thing a would-be contributor sees is a broken repo.
//
// The real unit-test entry point is `npm test`, which fans out to each
// workspace's own vitest config. This file only stops the root invocation
// lying about the state of the tree.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
});
