/**
 * action-card.test.ts - E2E flow for action card render + done writeback.
 *
 * Navigates to /threads/quill (the quill fixture thread seeded with an action card).
 * Asserts the ActionCard renders. Taps the done tick. Asserts done badge appears.
 * Reloads and asserts the done state persists (file was edited).
 *
 * Writebacks go to INBOX_ROOT (temp dir), never the committed fixtures.
 *
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("action card renders in /threads/quill with DONE tick button", async ({ page }) => {
  await page.goto("/threads/quill");

  // Action card is visible via data-testid.
  const card = page.locator('[data-testid="action-card"]').first();
  await expect(card).toBeVisible();

  // "Action" label is in the banner.
  await expect(card.getByText("Action", { exact: true })).toBeVisible();

  // DONE tick button is present (44px circle button).
  const doneBtn = card.getByTestId("action-done-btn");
  await expect(doneBtn).toBeVisible();
});

test("action card tick -> done badge", async ({ page }) => {
  await page.goto("/threads/quill");

  const card = page.locator('[data-testid="action-card"]').first();
  await expect(card).toBeVisible();

  const doneBtn = card.getByTestId("action-done-btn");
  await expect(doneBtn).toBeVisible();

  // Tap the done tick.
  await doneBtn.click();

  // Done badge appears on the card - now in the HEADER strip.
  const doneBadge = card.getByTestId("action-done-badge");
  await expect(doneBadge).toBeVisible({ timeout: 10_000 });

  // Receipt: dead controls are REMOVED, not disabled.
  await expect(doneBtn).not.toBeVisible({ timeout: 5_000 });
  await expect(card.getByTestId("action-dismiss-btn")).not.toBeVisible();

  // Collapsed receipt expands via the header toggle; the still-live
  // add-note affordance is inside the expanded body.
  await card.getByTestId("action-card-toggle").click();
  await expect(card.getByTestId("action-add-note-btn")).toBeVisible();

  // Toggle again collapses back to the clamped description.
  await card.getByTestId("action-card-toggle").click();
  await expect(card.getByTestId("action-add-note-btn")).not.toBeVisible();

  // Live tweak: clicking anywhere on the clamped body also expands.
  await card.getByTestId("action-card-clamp").click();
  await expect(card.getByTestId("action-add-note-btn")).toBeVisible();
});

test("action card done state persists after reload (file edited)", async ({ page }) => {
  await page.goto("/threads/quill");

  const card = page.locator('[data-testid="action-card"]').first();
  const doneBtn = card.getByTestId("action-done-btn");
  await expect(doneBtn).toBeVisible();

  await doneBtn.click();
  await expect(card.getByTestId("action-done-badge")).toBeVisible({ timeout: 10_000 });

  // Reload the page.
  await page.reload();

  // Done state persists: no tick button, done badge visible.
  const cardAfterReload = page.locator('[data-testid="action-card"]').first();
  await expect(cardAfterReload).toBeVisible();
  await expect(cardAfterReload.getByTestId("action-done-badge")).toBeVisible({ timeout: 10_000 });
  await expect(cardAfterReload.getByTestId("action-done-btn")).not.toBeVisible();

  // Confirm the temp fixture was edited (not the committed one).
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "quill", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  expect(content).toContain("done:");

  const committedFile = path.resolve("fixtures/inbox/quill/inbox/alex.md");
  const committed = fs.readFileSync(committedFile, "utf8");
  expect(committed).not.toContain("done:");
});
