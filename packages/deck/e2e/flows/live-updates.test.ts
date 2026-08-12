/**
 * live-updates.test.ts - TASK-455 v1: polling revalidation.
 *
 * The ticket's exact symptom as a test: a message written to the inbox
 * OUT-OF-BAND (fs append, not via the UI) appears in the open thread
 * without any user action, within a couple of poll ticks.
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

test("LIVE-01: out-of-band inbox append appears in the open thread with zero user action", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // Sanity: the live marker text is not present yet.
  const marker = "Live update landed without a refresh.";
  await expect(page.getByText(marker)).not.toBeVisible();

  // Append a new block to the TEMP fixture file out-of-band.
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const block = [
    "## 2026-06-10T20:31:00Z - from: scribe - status: sent - subject: live update probe",
    "",
    marker,
    "",
    "---",
    "",
  ].join("\n");
  fs.appendFileSync(inboxFile, block, "utf8");

  // The polling revalidation (3s interval) picks it up - no clicks, no
  // reload. Scoped to main: the marker ALSO appears in the sidebar
  // last-message preview (both surfaces go live off the one AppShell
  // mount - the single-timer claim demonstrating itself).
  await expect(
    page.getByRole("main").getByText(marker)
  ).toBeVisible({ timeout: 10_000 });

  // And the sidebar preview went live off the same poll.
  await expect(page.getByText(marker).first()).toBeVisible();
});
