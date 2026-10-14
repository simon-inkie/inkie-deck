/**
 * e2e/flows/helpers.ts - Shared helpers for E2E flow tests.
 *
 * resetFixtureInbox: removes and re-copies the temp inbox from fixtures/inbox
 * so each test starts from a known clean state (per-test isolation, D-07).
 *
 * assertGitClean: asserts that no NEW tracked files were modified during the run
 * (backstop: proves the live inbox and committed fixtures are untouched).
 * Uses a baseline snapshot captured at module load time to filter pre-existing dirt.
 *
 * sendButton: the composer's submit button, disambiguated from the gear beside it.
 *
 * expectDelivered / expectNotDelivered: the only honest proof that a composer
 * submit SENT anything. See the docstring on expectDelivered.
 *
 * ASCII only - no em-dashes.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The human in every fixture thread; deliveries land in <agent>/inbox/<user>.md. */
export const THREAD_USER = "alex";

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
 * Absolute path to a thread's inbox file inside the E2E temp root.
 *
 * @param agent - The agent whose thread the message belongs to.
 */
export function inboxPath(agent: string): string {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set - globalSetup did not run");
  return path.join(inboxRoot, agent, "inbox", `${THREAD_USER}.md`);
}

/** Current on-disk contents of a thread's inbox file ("" if not yet written). */
export function readInbox(agent: string): string {
  const file = inboxPath(agent);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * Assert that a composer submit actually DELIVERED, by the only evidence that
 * distinguishes delivery from a local pending bubble: the block on disk.
 *
 * WHY EVERY COMPOSER TEST NEEDS THIS. Submitting does not send. usePendingBatch
 * holds the text client-side and paints a pending bubble inside <main> that
 * renders the very words the user typed - so `getByRole("main").getByText(sent)`
 * is satisfied with NO send at all, and three tests in this suite were passing
 * on exactly that. The server-side append is the effect no client-side hold can
 * fake.
 *
 * Polls, because delivery is asynchronous by design (settle window, then a POST,
 * then the file write).
 *
 * @param agent - The thread the message was sent to.
 * @param needle - Text that must appear in the written block.
 * @param timeout - How long to wait for the delivery, in ms.
 */
export async function expectDelivered(
  agent: string,
  needle: string,
  timeout = 15_000
): Promise<void> {
  await expect
    .poll(() => readInbox(agent), {
      timeout,
      message: `expected "${needle}" to be delivered into ${agent}'s inbox on disk`,
    })
    .toContain(needle);
}

/**
 * Assert that nothing has been delivered yet - the held half of the hold.
 *
 * Deliberately NOT a poll: this asserts a non-event, so it reads the file once,
 * at a moment the caller has established is meaningful (e.g. after waiting past
 * the settle window a suspended timer would have fired in).
 *
 * @param agent - The thread that must NOT have received the text.
 * @param needle - Text that must be absent from the file.
 */
export function expectNotDelivered(agent: string, needle: string): void {
  expect(
    readInbox(agent),
    `"${needle}" must still be held, not written to ${agent}'s inbox`
  ).not.toContain(needle);
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
 * Assert that no NEW tracked files were modified by the E2E run.
 *
 * Compares against the baseline captured at module load time. Only new entries
 * (not present in the baseline) constitute a failure - pre-existing uncommitted
 * source changes are expected (e.g. package.json, pnpm-lock.yaml during dev).
 *
 * Throws with a FAIL message listing any newly-dirty files so the
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
