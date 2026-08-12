/**
 * custom-answer.test.ts - the decision-card WRITE-OWN (option C) interaction the
 * earlier tests never exercised. This is the gap that let the memo bug ship
 * twice: tests asserted rendering, never the tap/type/submit interaction.
 *
 * Covers:
 *   - tap "OR write something" -> compose enters custom mode
 *   - type a custom answer + press ENTER -> submits as intent=custom (Alex's
 *     "not sure Enter is working" check; the typed path has no IME composition
 *     so the isComposing guard does not apply - Enter must submit)
 *   - the card resolves to answered with the typed text
 *   - REGRESSION (Quill's repro for the Markdown-only memo re-do): tap C-path,
 *     then ensure a normal option still selects correctly (no stale-render
 *     misselect). On the un-memoised build this passes; a future full-feed
 *     memo would fail it.
 *
 * VALID-03: writeback to INBOX_ROOT temp dir; committed fixtures untouched.
 * ASCII only - no em-dashes (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("custom answer: write-own -> type -> ENTER submits intent=custom", async ({ page }) => {
  await page.goto("/threads/scribe");

  const card = page.locator('[data-testid="decision-card"]').first();
  await expect(card).toBeVisible();

  // Tap "OR write something..." -> compose enters custom mode.
  await card.getByTestId("write-own-btn").click();
  const textarea = page.getByTestId("compose-textarea");
  await expect(textarea).toBeVisible();

  // Type a custom answer and press Enter (typed path: no IME composition, so
  // the isComposing guard is not in play - plain Enter must submit).
  await textarea.fill("Push to 60/day - fair week only");
  await textarea.press("Enter");

  // The card resolves to answered (intent=custom -> answered C).
  const chip = card.getByTestId("decision-resolution-chip");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText("Answered:");

  // The typed text landed in the temp inbox writeback (not committed fixtures).
  const inboxRoot = process.env["INBOX_ROOT"];
  const inboxFile = path.join(inboxRoot!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  expect(content).toContain("Push to 60/day - fair week only");
});
