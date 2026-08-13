/**
 * e2e/flows/helpers.ts - Shared helpers for E2E flow tests.
 *
 * resetFixtureInbox: removes and re-copies the temp inbox from fixtures/inbox
 * so each test starts from a known clean state (per-test isolation, D-07).
 *
 * assertGitClean: asserts that no NEW tracked files were modified during the run
 * (VALID-03 backstop: proves the live inbox and committed fixtures are untouched).
 * Uses a baseline snapshot captured at module load time to filter pre-existing dirt.
 *
 * sendButton: the composer's submit button, disambiguated from the gear beside it.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import type { Locator, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The composer's submit button.
 *
 * WHY THIS EXISTS RATHER THAN AN INLINE getByRole. Playwright's role-name
 * matching is substring-based by default, and the composer renders a gear
 * button next to Send whose accessible name is "Batch send settings" - which
 * CONTAINS "send". A bare { name: "Send" } therefore resolves to two elements
 * and every use dies on strict mode, which is exactly how this suite was red.
 * `exact: true` is the whole fix; the helper is so the next spec inherits it
 * instead of rediscovering it.
 *
 * @param page - The Playwright page under test.
 */
export function sendButton(page: Page): Locator {
  return page.getByRole("button", { name: "Send", exact: true });
}

/**
 * Reset the E2E temp inbox to a clean copy of fixtures/inbox.
 *
 * Call in test.beforeEach for tests that write to the inbox (tap-to-answer,
 * thread-compose) so each test starts from an identical known state.
 * Also removes queue-state.json so queue state is clean for each test.
 */
export function resetFixtureInbox(): void {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set - globalSetup did not run");

  // Remove and re-copy from committed fixtures.
  fs.rmSync(inboxRoot, { recursive: true, force: true });
  fs.cpSync(path.resolve("fixtures/inbox"), inboxRoot, { recursive: true });

  // Remove queue-state.json so ageing tests start from a clean state.
  const queueStatePath = process.env["QUEUE_STATE_PATH"];
  if (queueStatePath && fs.existsSync(queueStatePath)) {
    fs.rmSync(queueStatePath);
  }
}

/**
 * Reset the E2E temp agents root to a clean copy of fixtures/agents.
 *
 * Call in test.beforeEach for tests that write .model files (model-selector)
 * so each test starts from the fixture state (no .model = inherit default).
 */
export function resetFixtureAgents(): void {
  const agentsRoot = process.env["AGENTS_ROOT"];
  if (!agentsRoot) throw new Error("AGENTS_ROOT not set - globalSetup did not run");

  fs.rmSync(agentsRoot, { recursive: true, force: true });
  fs.cpSync(path.resolve("fixtures/agents"), agentsRoot, { recursive: true });
}

/**
 * Get the set of currently dirty (modified or untracked) file paths.
 * Used internally to capture a baseline and compare after tests.
 */
function getGitDirtyLines(repoRoot: string): Set<string> {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  return new Set(lines);
}

// Capture the baseline dirty state at module load time (before any tests mutate anything).
// Any lines in the post-test snapshot that were already here are pre-existing, not from the E2E run.
const BASELINE_DIRTY = getGitDirtyLines(path.resolve("."));

/**
 * Assert that no NEW tracked files were modified by the E2E run (VALID-03).
 *
 * Compares against the baseline captured at module load time. Only new entries
 * (not present in the baseline) constitute a failure - pre-existing uncommitted
 * source changes are expected (e.g. package.json, pnpm-lock.yaml during dev).
 *
 * Throws with a VALID-03 FAIL message listing any newly-dirty files so the
 * failure is immediately actionable.
 *
 * Call in test.afterAll(() => assertGitClean(path.resolve("."))) on each test file.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function assertGitClean(repoRoot: string): void {
  const current = getGitDirtyLines(repoRoot);
  const newLines: string[] = [];
  for (const line of current) {
    if (!BASELINE_DIRTY.has(line)) {
      newLines.push(line);
    }
  }
  if (newLines.length > 0) {
    throw new Error(
      `VALID-03 FAIL: E2E run produced new git-dirty files (live inbox or fixtures were written):\n${newLines.join("\n")}`
    );
  }
}
