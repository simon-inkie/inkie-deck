/**
 * scroll-follow.test.ts - TASK-454: vertical real-estate + scroll-to-latest.
 *
 * Covers the four behaviours of the pass:
 *   1. App-bar identity fold: thread-header testid lives in the top bar on
 *      thread routes, absent elsewhere.
 *   2. Scroll-to-latest on load: last message in viewport without scrolling.
 *   3. Follow-bottom on out-of-band arrival while at the bottom.
 *   4. NEVER-yank: scrolled-up + out-of-band arrival leaves the viewport
 *      alone (Atlas's TASK-455 scroll pin as a test).
 *   5. Param-change initial jump: navigating thread A -> thread B still
 *      lands B on its latest message (route component stays mounted).
 *
 * ASCII only - no em-dashes (FND-05).
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

function appendBlock(marker: string) {
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const block = [
    `## 2026-06-10T20:32:00Z - from: scribe - status: sent - subject: scroll probe`,
    "",
    marker,
    "",
    "---",
    "",
  ].join("\n");
  fs.appendFileSync(inboxFile, block, "utf8");
}

test("TASK-454: app bar carries the thread identity; standalone header row is gone", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // The thread-header testid now lives inside the top app bar (header element).
  const header = page.getByTestId("thread-header");
  await expect(header).toContainText("scribe");
  await expect(page.locator("header").getByTestId("thread-header")).toBeVisible();

  // On non-thread routes the identity slot is absent.
  await page.goto("/projects");
  await expect(page.getByTestId("thread-header")).not.toBeVisible();
});

test("TASK-454: thread loads scrolled to the latest message", async ({ page }) => {
  await page.goto("/threads/scribe");

  // The LAST block in the scribe fixture is the live-working block
  // ("Can you check the wholesale numbers too?"). Without any user scroll it
  // must already be in the viewport.
  const lastMessage = page
    .getByRole("main")
    .getByText("Can you check the wholesale numbers too?", { exact: false })
    .last();
  await expect(lastMessage).toBeInViewport({ timeout: 5_000 });
});

test("TASK-454: at bottom, an out-of-band arrival follows into view", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  const marker = "Follow-bottom arrival lands in view.";
  appendBlock(marker);

  // Within a couple of polls the new bubble is not just present - it is IN
  // the viewport, because the user was at the bottom.
  await expect(
    page.getByRole("main").getByText(marker)
  ).toBeInViewport({ timeout: 10_000 });
});

test("TASK-454: scrolled up, an out-of-band arrival NEVER moves the viewport (455 pin)", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // Wait for hydration's initial scroll-to-latest to COMPLETE before
  // scrolling up - otherwise the manual scroll races the initial jump and
  // the jump lands after it (a test-mechanics race, not a product bug).
  await expect(
    page
      .getByRole("main")
      .getByText("Can you check the wholesale numbers too?", { exact: false })
      .last()
  ).toBeInViewport({ timeout: 5_000 });

  // Scroll the message pane to the very top.
  const pane = page.getByRole("main").locator("div.overflow-y-auto").first();
  await pane.evaluate((el) => {
    el.scrollTop = 0;
  });

  const marker = "Silent below-the-fold arrival.";
  appendBlock(marker);

  // Wait long enough for at least two polls to fire.
  await page.waitForTimeout(7_000);

  // The pane must still be at the top - no yank.
  const scrollTop = await pane.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeLessThan(50);

  // The message DID arrive in the DOM (the poll worked) - it is just below
  // the fold, exactly as disclosed in the 455 plan.
  await expect(page.getByRole("main").getByText(marker)).toBeAttached();
});

test("TASK-454: navigating thread A -> thread B lands B on its latest message (Atlas fold)", async ({
  page,
}) => {
  await page.goto("/threads/quill");
  // Navigate via the sidebar link - same mounted route component, param change.
  await page.getByRole("link", { name: /scribe/i }).first().click();
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  const lastMessage = page
    .getByRole("main")
    .getByText("Can you check the wholesale numbers too?", { exact: false })
    .last();
  await expect(lastMessage).toBeInViewport({ timeout: 5_000 });
});
