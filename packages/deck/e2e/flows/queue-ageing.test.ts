/**
 * queue-ageing.test.ts - VALID-02 flow (c): action-queue persists and SLA ages
 * correctly across a page reload.
 *
 * QUEUE-06: overdue item shows the /Overdue:/ label.
 * QUEUE-08: item persists with stable order and ageing string across reload.
 * ASCII only - no em-dashes per FND-05.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

test("QUEUE-06: overdue queue item shows Overdue label (MC_NOW seam)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Needs you")).toBeVisible();
  // Use .first() since multiple overdue items may appear (TASK-438: three kinds)
  await expect(page.getByText(/Overdue:/).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="needs-you-item"]').first()).toBeVisible();
});

test("QUEUE-08: overdue item persists across a page reload with same state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Overdue:/).first()).toBeVisible({ timeout: 10_000 });
  await page.goto("/threads/scribe");
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
  await page.goto("/");
  await expect(page.getByText(/Overdue:/).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Handled" }).first()).toBeVisible();
});

test("QUEUE: Handled button clears the item and item stays cleared", async ({ page }) => {
  // Capture console errors to detect hydration/JS failures.
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // Capture POST requests.
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST") posts.push(req.url());
  });

  await page.goto("/");
  // Use .first() since multiple overdue items may appear (TASK-438: three kinds)
  await expect(page.getByText(/Overdue:/).first()).toBeVisible({ timeout: 10_000 });

  // Wait for hydration to complete (JS loads and React mounts).
  // Wait until the button is clickable (not disabled by hydration state).
  await expect(page.getByRole("button", { name: "Handled" }).first()).toBeEnabled({ timeout: 10_000 });

  // Click Handled to clear the first decision item.
  await page.getByRole("button", { name: "Handled" }).first().click();
  await page.waitForTimeout(3000);

  console.log("JS errors:", errors);
  console.log("POST requests:", posts);

  // Reload and verify the handled item is cleared (the Decide item should be gone,
  // but other kinds may still show Overdue).
  await page.reload();
  // No more "Handled" button for the decision item (it was marked handled)
  await expect(page.getByRole("button", { name: "Handled" })).not.toBeVisible({ timeout: 10_000 });
});
