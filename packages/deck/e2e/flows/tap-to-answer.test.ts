/**
 * tap-to-answer.test.ts - flow (b): tapping an option writes the answer
 * block back to the (temp) fixture inbox and the card flips to answered.
 *
 * answerCard writes the answer block; card shows "Answered: A" badge.
 * Writeback goes to INBOX_ROOT (temp dir), never the committed fixtures/inbox.
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("CARD-02: tapping option A flips card to answered and writes answer to temp fixture", async ({ page }) => {
  await page.goto("/threads/scribe");

  // Card container is visible via data-testid.
  const card = page.locator('[data-testid="decision-card"]').first();
  await expect(card).toBeVisible();

  // Option A is tappable.
  await expect(page.getByRole("button", { name: /Hold spend/ })).toBeVisible();

  // Tap option A.
  await page.getByRole("button", { name: /Hold spend/ }).click();

  // RR7 fetcher posts and revalidates - the card becomes a RECEIPT:
  // resolution chip in the header strip, preferring the option LABEL over the
  // bare letter ("Answered: Hold spend at..." not "Answered: A").
  const chip = card.getByTestId("decision-resolution-chip");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText("Answered:");

  // Option buttons should disappear now that the card is answered (the
  // receipt is collapsed; the record rows appear on expand).
  await expect(page.getByRole("button", { name: /Hold spend/ })).not.toBeVisible({ timeout: 10_000 });

  // Expand the receipt: the chosen-option record row is in the expanded body.
  // Exact match - the header chip also carries the label (label-over-letter).
  await card.getByTestId("decision-card-toggle").click();
  await expect(
    card.getByText("Hold spend at £45/day", { exact: true })
  ).toBeVisible();

  // Verify writeback landed in the TEMP fixture, not the committed one.
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  expect(content).toContain("answer: A");

  // Confirm the committed fixture is unchanged (still has no "answer: A").
  const committedFile = path.resolve("fixtures/inbox/scribe/inbox/alex.md");
  const committed = fs.readFileSync(committedFile, "utf8");
  expect(committed).not.toContain("answer: A");
});
