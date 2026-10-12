/**
 * tmux-tab.test.ts - the per-thread terminal view, plus what is left
 * of the old Team tab at /tmux.
 *
 * The e2e env points MC_TMUX_SESSION at a guaranteed-missing session
 * (set in e2e/setup.mjs), so these assert the DETERMINISTIC paths: the
 * page loads, the states are honest, and hostile ?window= values never 500.
 * Live capture is exercised manually on the real session.
 *
 * /tmux is the Activity page now - the window picker and the
 * always-on pane came off it (a constant tmux readout was judged unnecessary),
 * so its assertions here moved from "the pane's empty state" to
 * "the page still loads and is honest with no activity configured". The e2e
 * env sets no activity root, so that is the branch it exercises. The per-thread
 * ?view=tmux surface below is untouched and remains the real pane.
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

test("TASK-691: the Activity page loads and says so when activity is not configured", async ({
  page,
}) => {
  await page.goto("/tmux");
  await expect(page).toHaveURL(/\/tmux/);

  // No activity root in the e2e env -> the honest not-available state.
  await expect(page.getByText("Activity is not available on this instance")).toBeVisible();
  // The pane and its window picker are gone from this page: the
  // live terminal lives on the thread, and nothing here can send.
  await expect(page.getByTestId("tmux-window-picker")).not.toBeVisible();
  await expect(page.getByTestId("tmux-pane")).not.toBeVisible();
  await expect(page.getByTestId("tmux-compose-input")).not.toBeVisible();
});

test("TASK-691: leftover ?window= values from old bookmarks never 500", async ({
  page,
}) => {
  // The param is not read any more, but the old links exist in browser history.
  for (const q of ["?window=ghost", "?window=quill%3Bls", "?window=..%2Fio"]) {
    const response = await page.goto(`/tmux${q}`);
    expect(response?.status(), q).toBe(200);
    await expect(page.getByText("Activity is not available on this instance")).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Per-thread chat/tmux toggle.
// ---------------------------------------------------------------------------

test("TASK-437.1: toggle flips thread to terminal mode and back; compose follows", async ({
  page,
}) => {
  await page.goto("/threads/scribe");
  await expect(page.getByTestId("compose-textarea")).toBeVisible();

  // Flip to terminal mode.
  await page.getByTestId("thread-view-tmux").click();
  await expect(page).toHaveURL(/view=tmux/);
  await expect(page.getByTestId("thread-tmux-view")).toBeVisible();
  // e2e session is guaranteed-missing -> honest unavailable state.
  await expect(page.getByText("Pane unavailable")).toBeVisible();
  // Compose and messages are gone - view-only surface.
  await expect(page.getByTestId("compose-textarea")).not.toBeVisible();

  // Flip back.
  await page.getByTestId("thread-view-chat").click();
  await expect(page).not.toHaveURL(/view=tmux/);
  await expect(page.getByTestId("compose-textarea")).toBeVisible();
});

test("TASK-437.1: tmux view does NOT flip read receipts on disk (receipt honesty)", async ({
  page,
}) => {
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");

  // The fixture's first scribe block ships as status: sent.
  const before = fs.readFileSync(inboxFile, "utf8");
  expect(before).toContain("from: scribe - status: sent");

  // Load the thread DIRECTLY in tmux view - no chat render happens.
  await page.goto("/threads/scribe?view=tmux");
  await expect(page.getByTestId("thread-tmux-view")).toBeVisible();
  await page.waitForTimeout(1_500); // a poll tick or two

  const after = fs.readFileSync(inboxFile, "utf8");
  expect(after).toContain("from: scribe - status: sent");

  // And the chat half of the toggle carries the unread dot.
  await expect(page.getByTestId("thread-view-chat-unread")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Read/write tmux (send-keys v1)
// ---------------------------------------------------------------------------

test("read/write: compose renders in terminal view; a send to a dead window surfaces an inline error", async ({
  page,
}) => {
  // The e2e session is guaranteed-missing, so this exercises the FAILURE path
  // end-to-end deterministically: compose -> POST /api/tmux-send -> the
  // allowlist gate rejects (no live window) -> inline error. The success path
  // (literal text + separate Enter) is unit-pinned in test/tmux.test.ts.
  await page.goto("/threads/scribe?view=tmux");
  await expect(page.getByTestId("thread-tmux-view")).toBeVisible();

  // Compose renders even though the pane is unavailable - it is gated on the
  // send target, not on a successful capture (a tick can fail transiently).
  const input = page.getByTestId("tmux-compose-input");
  await expect(input).toBeVisible();

  await input.fill("status?");
  await page.getByTestId("tmux-compose-send").click();

  // The window is not live in the missing session -> honest inline error,
  // never a 500, and the read-only pane state is untouched.
  await expect(page.getByTestId("tmux-compose-error")).toBeVisible();
  await expect(page.getByTestId("thread-tmux-view")).toBeVisible();
});

test("read/write: empty / whitespace-only text cannot be sent", async ({ page }) => {
  await page.goto("/threads/scribe?view=tmux");
  const send = page.getByTestId("tmux-compose-send");
  // Disabled with an empty box.
  await expect(send).toBeDisabled();
  // Whitespace-only stays disabled (trim gate in the component).
  await page.getByTestId("tmux-compose-input").fill("   ");
  await expect(send).toBeDisabled();
});
