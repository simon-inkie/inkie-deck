/**
 * pending-hold.test.ts - the hold itself (TASK-500), which the rest of the
 * suite deliberately turns down to its floor.
 *
 * WHY THIS FILE EXISTS. Submitting in MC does not send: usePendingBatch holds
 * the text and delivers once the user settles. Every other composer spec seeds
 * the minimum hold so it can test its own subject instead of waiting, which
 * leaves the hold - the product behaviour those tests are configured around -
 * untested at this level. It is tested here, once, on purpose, and these are
 * the only tests in the suite that pay wall-clock time for it.
 *
 * Each describe block seeds its own hold via storageState, the same lever the
 * suite default uses (see e2e/batch-prefs-state.ts).
 *
 * The assertions are on-disk deliveries, never the pending bubble: the bubble
 * renders the user's own words locally and so cannot distinguish "sent" from
 * "held". Where a test asserts that ONE message arrived, it also counts the
 * blocks, because "one message arrived" is equally true of a merge that worked
 * and of a second fragment that was silently dropped.
 *
 * NOT COVERED HERE, and why:
 *   - SAFETY_CAP_MS (5 min of typing while a batch is held delivers it anyway).
 *     It is a fixed constant with no test seam - deliberately not configurable,
 *     per the hook's own docs - so an e2e proof would cost five minutes of wall
 *     clock per run. The reducer transition is pure and unit-testable; that is
 *     the right level for it.
 *   - Beacon/pagehide durability and cross-session recovery. Real behaviour,
 *     but it is about a tab going away rather than about the hold, and pinning
 *     it means driving localStorage mirrors and page lifecycle events. It wants
 *     its own spec rather than a corner of this one.
 *
 * VALID-03: writes only under INBOX_ROOT (temp). ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  assertGitClean,
  expectDelivered,
  expectNotDelivered,
  readInbox,
  resetFixtureInbox,
  sendButton,
  THREAD_USER,
} from "./helpers.js";
import { batchPrefsStorageState } from "../batch-prefs-state.js";

/** Short enough to wait out twice inside one test, above the [2, 300] floor. */
const SHORT_HOLD_S = 3;
/** Long enough that nothing can settle mid-test; delivery must be forced. */
const LONG_HOLD_S = 300;

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

/**
 * How many blocks in this thread came from the human.
 *
 * The discriminator for batching: two fragments merged into one delivery move
 * this by exactly 1, two separate deliveries move it by 2, and a dropped
 * fragment leaves the count right but the body short - which is why the tests
 * below assert both.
 */
function ownBlockCount(agent: string): number {
  const matches = readInbox(agent).match(
    new RegExp(`- from: ${THREAD_USER} -`, "g")
  );
  return matches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// 1. It just sends.
// ---------------------------------------------------------------------------

test.describe("a settled batch", () => {
  test.use({ storageState: batchPrefsStorageState(SHORT_HOLD_S) });

  test("delivers itself, once, with no further user action", async ({ page }) => {
    await page.goto("/threads/scribe");
    await expect(page.getByTestId("thread-header")).toContainText("scribe");
    const before = ownBlockCount("scribe");

    const body = "Hold test: this one settles on its own, marker 7k2p";
    await page.getByTestId("compose-textarea").fill(body);
    await sendButton(page).click();

    // Held, not sent: read immediately, before the settle window can elapse.
    expectNotDelivered("scribe", body);
    await expect(page.getByTestId("pending-subtle-bubble")).toBeVisible();

    // Then it goes by itself. Nothing is clicked between the two assertions.
    await expectDelivered("scribe", body, SHORT_HOLD_S * 1000 + 10_000);
    expect(ownBlockCount("scribe")).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Send, then add more text. The case the state machine exists for.
// ---------------------------------------------------------------------------

test.describe("a second message typed during the hold", () => {
  test.use({ storageState: batchPrefsStorageState(SHORT_HOLD_S) });

  test("suspends the timer and arrives merged into ONE delivered block", async ({
    page,
  }) => {
    await page.goto("/threads/scribe");
    await expect(page.getByTestId("thread-header")).toContainText("scribe");
    const before = ownBlockCount("scribe");

    const first = "Hold test: first fragment, marker 5m1q";
    const second = "Hold test: second fragment, marker 8z4t";

    const textarea = page.getByTestId("compose-textarea");
    await textarea.fill(first);
    await sendButton(page).click();

    // Start typing the follow-up. One keystroke is the whole transition:
    // PENDING -> SUSPENDED clears the settle timer (a HARD suspend), so the
    // first fragment can no longer slip out underneath the draft.
    await textarea.pressSequentially(second, { delay: 20 });
    await expect(page.getByTestId("pending-live-draft")).toBeVisible();

    // Past twice the hold with the draft still unsent. Without the suspend the
    // first fragment would have been delivered alone by now - this wait IS the
    // assertion, so it is a deliberate sleep rather than a poll.
    await page.waitForTimeout(SHORT_HOLD_S * 2 * 1000);
    expectNotDelivered("scribe", first);

    // Submit the follow-up and let the batch settle.
    await sendButton(page).click();
    await expectDelivered("scribe", second, SHORT_HOLD_S * 1000 + 10_000);

    // ONE block carrying BOTH fragments. Each half of this is load-bearing:
    // the count alone would pass if the second fragment had been dropped, and
    // the contents alone would pass if the two had gone out as two messages.
    expect(ownBlockCount("scribe")).toBe(before + 1);
    const delivered = readInbox("scribe");
    expect(delivered).toContain(first);
    expect(delivered).toContain(second);
  });
});

// ---------------------------------------------------------------------------
// 3. Send, then unsend. 4. Send now.
// ---------------------------------------------------------------------------

test.describe("a held batch", () => {
  // Nothing may settle by itself in here: both tests are about what the user
  // does to a batch that is still being held.
  test.use({ storageState: batchPrefsStorageState(LONG_HOLD_S) });

  test("unsent: nothing is delivered, and the words come back to the composer", async ({
    page,
  }) => {
    await page.goto("/threads/scribe");
    await expect(page.getByTestId("thread-header")).toContainText("scribe");
    const before = ownBlockCount("scribe");

    const body = "Hold test: I changed my mind about this one, marker 3w9v";
    const textarea = page.getByTestId("compose-textarea");
    await textarea.fill(body);
    await sendButton(page).click();
    await expect(textarea).toHaveValue("");

    await page.getByTestId("pending-cancel").click();

    // Both halves. A cancel that delivered anyway is the obvious failure; a
    // cancel that silently ate the text is the quiet one, and costs the user
    // their words with no way to get them back.
    await expect(page.getByTestId("pending-subtle-bubble")).toHaveCount(0);
    expectNotDelivered("scribe", body);
    expect(ownBlockCount("scribe")).toBe(before);
    await expect(textarea).toHaveValue(body);
  });

  test("sent now: tapping the badge delivers immediately, skipping the hold", async ({
    page,
  }) => {
    await page.goto("/threads/scribe");
    await expect(page.getByTestId("thread-header")).toContainText("scribe");
    const before = ownBlockCount("scribe");

    const body = "Hold test: this cannot wait, marker 6b8n";
    await page.getByTestId("compose-textarea").fill(body);
    await sendButton(page).click();
    expectNotDelivered("scribe", body);

    // The hold is 300s, so a delivery here can only have come from send-now.
    await page.getByTestId("pending-status-send-now").click();
    await expectDelivered("scribe", body);
    expect(ownBlockCount("scribe")).toBe(before + 1);
  });

  test("carries its own thread: leaving mid-hold delivers to the thread it was written in", async ({
    page,
  }) => {
    // The incident behind pending-batch.ts's ownership rules: on a thread
    // switch the route already reads the NEW thread while the batch still
    // holds the OLD thread's text, and the delivery went to whichever thread
    // happened to be on screen. Nothing about the resulting block looks wrong;
    // only the inbox it landed in is. So the assertion is on BOTH inboxes.
    await page.goto("/threads/scribe");
    await expect(page.getByTestId("thread-header")).toContainText("scribe");

    const body = "Hold test: written to scribe, delivered after I left, marker 2r5x";
    await page.getByTestId("compose-textarea").fill(body);
    await sendButton(page).click();
    expectNotDelivered("scribe", body);

    // Client-side navigation away, which is what triggers deliver-on-switch.
    await page.getByRole("navigation").getByRole("link", { name: /^quill/i }).click();
    await expect(page.getByTestId("thread-header")).toContainText("quill");

    await expectDelivered("scribe", body);
    expectNotDelivered("quill", body);
  });
});
