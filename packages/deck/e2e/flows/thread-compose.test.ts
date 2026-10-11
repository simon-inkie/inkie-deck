/**
 * thread-compose.test.ts - flow (d): sending a reply appends to the
 * (temp) fixture inbox and the reply appears in the thread.
 *
 * compose writes a new block and it appears after revalidation.
 * Writeback goes to INBOX_ROOT (temp dir), never the committed fixtures.
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import {
  resetFixtureInbox,
  assertGitClean,
  sendButton,
  expectDelivered,
} from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("THRD-04: sending a reply appends to temp fixture inbox and appears in thread", async ({ page }) => {
  await page.goto("/threads/scribe");

  // Thread loads successfully (header shows the bare agent name)
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  // The compose box is at the bottom
  await expect(page.getByPlaceholder("Write a reply...")).toBeVisible();

  // Type a reply with a unique body we can assert on
  const replyBody = "Test reply from E2E compose flow - unique marker 9x7z";
  await page.getByPlaceholder("Write a reply...").fill(replyBody);

  // Submit the reply
  await sendButton(page).click();

  // The reply landed in the TEMP fixture file. Polled, because a
  // submit is not a send - the composer holds the text for the settle window
  // first, so a synchronous read here races the delivery it is asserting.
  await expectDelivered("scribe", replyBody);

  // And it appears in the thread (RR7 revalidates after the action). Scope to
  // the message list: <main> would also match the pending bubble, which shows
  // the typed words while they are still held, and the sidebar's last-message
  // preview repeats them again.
  await expect(
    page.getByTestId("thread-scroll").getByText(replyBody)
  ).toBeVisible({ timeout: 10_000 });

  // Confirm the committed fixture does NOT contain our reply.
  const committedFile = path.resolve("fixtures/inbox/scribe/inbox/alex.md");
  const committed = fs.readFileSync(committedFile, "utf8");
  expect(committed).not.toContain(replyBody);
});

test("THRD-04: compose textarea is visible and can be filled via data-testid", async ({ page }) => {
  await page.goto("/threads/scribe");

  // Verify via data-testid (supplemental selector)
  const textarea = page.locator('[data-testid="compose-textarea"]');
  await expect(textarea).toBeVisible();

  // Can type into it
  await textarea.fill("Hello via testid selector");
  await expect(textarea).toHaveValue("Hello via testid selector");
});
