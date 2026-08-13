/**
 * thread-compose.test.ts - VALID-02 flow (d): sending a reply appends to the
 * (temp) fixture inbox and the reply appears in the thread.
 *
 * THRD-04: compose writes a new block and it appears after revalidation.
 * VALID-03: writeback goes to INBOX_ROOT (temp dir), never the committed fixtures.
 * ASCII only - no em-dashes per FND-05.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean, sendButton } from "./helpers.js";
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

  // Wait for the reply to appear in the thread (RR7 revalidates after action).
  // Scope to <main>: in the two-pane shell the left sidebar also shows the
  // agent's last-message preview, so the reply text legitimately appears twice
  // in the DOM. We assert it landed in the conversation pane specifically.
  await expect(
    page.getByRole("main").getByText(replyBody)
  ).toBeVisible({ timeout: 10_000 });

  // VALID-03: verify the reply landed in the TEMP fixture file.
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  expect(content).toContain(replyBody);

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
