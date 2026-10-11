/**
 * card-render.test.ts - flow (a): decision card renders with tappable option buttons.
 *
 * Navigates to /threads/scribe and asserts:
 * - The decision card container is visible (data-testid="decision-card")
 * - The "Decision" label is visible (exact match to avoid matching subject text)
 * - Option button [A] "Hold spend..." is tappable (role=button)
 * - "OR write something..." affordance is present (MC #2: replaces "Push back")
 *
 * Card blocks render as interactive DecisionCard.
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import { assertGitClean } from "./helpers.js";
import path from "node:path";

test.afterAll(() => assertGitClean(path.resolve(".")));

test("CARD-01: decision card renders with tappable option buttons on /threads/scribe", async ({ page }) => {
  await page.goto("/threads/scribe");

  // Use data-testid for the card container (robust selector).
  const card = page.locator('[data-testid="decision-card"]').first();
  await expect(card).toBeVisible();

  // The card header label "Decision" - use exact match to avoid subject text.
  // Scope to the card container to avoid other text on the page.
  await expect(card.getByText("Decision", { exact: true })).toBeVisible();

  // Option A button is visible and tappable (role=button).
  await expect(page.getByRole("button", { name: /Hold spend/ })).toBeVisible();

  // MC #2: "OR write something..." affordance replaces the plain "Push back" button.
  await expect(page.getByTestId("write-own-btn")).toBeVisible();
});
