/**
 * review-panel.test.ts - E2E tests for the MD review side-panel.
 *
 * Tests (per plan section 7):
 *   - chip click: upload .md via picker -> chip click opens panel + URL state
 *     + refresh persistence.
 *   - deep link: navigate directly to /threads/<agent>?doc=<fixture path> ->
 *     panel open on load.
 *   - denial: ?doc= pointing at .env inside the e2e review root -> in-panel
 *     "not available", content absent from DOM.
 *   - close: close button clears param, panel gone.
 *   - mobile viewport: panel presents as sheet.
 *
 * Uses resetFixtureInbox + baseline assertGitClean.
 * Workers stay 1 per playwright.config.ts.
 *
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean, sendButton } from "./helpers.js";
import path from "node:path";

const FIXTURES_DIR = path.resolve("e2e/fixtures");

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

// ---------------------------------------------------------------------------
// Chip click -> panel opens, URL state, refresh persistence
// ---------------------------------------------------------------------------

test("TASK-431 chip click: upload .md, chip opens panel, URL carries ?doc=, refresh persists", async ({
  page,
}) => {
  await page.goto("/threads/scribe");
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  // Upload a .md file via the picker.
  const fileInput = page.getByTestId("attach-file-input");
  await fileInput.setInputFiles(path.join(FIXTURES_DIR, "test-notes.md"));

  // Wait for the pending chip to appear (replaces old markdown-in-textarea).
  await expect(page.getByTestId("pending-attachment-chip")).toBeVisible({ timeout: 10_000 });

  // The textarea should NOT contain markdown syntax any more.
  const textarea = page.getByTestId("compose-textarea");
  const draftBeforeSend = await textarea.inputValue();
  expect(draftBeforeSend).not.toMatch(/\[.*\]\(\/attachments\/.*\.md\)/);

  // Send the message.
  await sendButton(page).click();

  // After send, the pending chip should be cleared.
  await expect(page.getByTestId("pending-attachment-chip")).toHaveCount(0, { timeout: 5_000 });

  // The chip should now be visible in the thread as a ReviewableChip (button).
  const chip = page
    .getByRole("main")
    .locator('button[aria-label^="Open in review panel"]');
  await expect(chip).toBeVisible({ timeout: 10_000 });

  // Click the chip to open the panel.
  await chip.click();

  // The panel should appear.
  const panel = page.getByTestId("review-panel");
  await expect(panel).toBeVisible({ timeout: 5_000 });

  // URL should carry the ?doc= param.
  const url = new URL(page.url());
  expect(url.searchParams.has("doc")).toBe(true);

  // Panel should render some markdown content.
  await expect(panel).toContainText("Test Notes", { timeout: 5_000 });

  // Refresh: panel should still be open (state persisted in URL).
  await page.reload();
  await expect(page.getByTestId("review-panel")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Deep link: navigate to /threads/<agent>?doc=<path> -> panel open on load
// ---------------------------------------------------------------------------

test("TASK-431 deep link: ?doc= on load opens panel", async ({ page }) => {
  // The REVIEW_ROOT_E2E env var is set by setup.mjs.
  const reviewRoot = process.env["REVIEW_ROOT_E2E"];
  if (!reviewRoot) {
    test.skip(true, "REVIEW_ROOT_E2E not set - setup.mjs did not run");
    return;
  }

  const docPath = path.join(reviewRoot, "test-notes.md");
  const docParam = encodeURIComponent(docPath);

  await page.goto(`/threads/scribe?doc=${docParam}`);
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  // Panel should be open on load.
  const panel = page.getByTestId("review-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("Test Notes", { timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Denial: .env inside review root -> "Document not available"
// ---------------------------------------------------------------------------

test("TASK-431 denial: .env inside review root shows 'not available'", async ({ page }) => {
  const reviewRoot = process.env["REVIEW_ROOT_E2E"];
  if (!reviewRoot) {
    test.skip(true, "REVIEW_ROOT_E2E not set - setup.mjs did not run");
    return;
  }

  // Point ?doc= at the .env file that setup.mjs placed inside the review root.
  const envPath = path.join(reviewRoot, ".env");
  const docParam = encodeURIComponent(envPath);

  await page.goto(`/threads/scribe?doc=${docParam}`);
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  // Panel should open but show "not available".
  const panel = page.getByTestId("review-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole("alert")).toContainText("not available", {
    timeout: 5_000,
  });

  // The secret value must NOT appear anywhere in the DOM.
  const bodyText = await page.locator("body").textContent();
  expect(bodyText).not.toContain("supersecret");
});

// ---------------------------------------------------------------------------
// Close: close button clears param, panel gone
// ---------------------------------------------------------------------------

test("TASK-431 close: close button removes ?doc= param", async ({ page }) => {
  const reviewRoot = process.env["REVIEW_ROOT_E2E"];
  if (!reviewRoot) {
    test.skip(true, "REVIEW_ROOT_E2E not set - setup.mjs did not run");
    return;
  }

  const docPath = path.join(reviewRoot, "test-notes.md");
  const docParam = encodeURIComponent(docPath);
  await page.goto(`/threads/scribe?doc=${docParam}`);

  const panel = page.getByTestId("review-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // Click the close button.
  await panel.getByRole("button", { name: "Close review panel" }).click();

  // Panel should disappear.
  await expect(panel).not.toBeVisible({ timeout: 5_000 });

  // URL should no longer carry ?doc=.
  const url = new URL(page.url());
  expect(url.searchParams.has("doc")).toBe(false);
});

// ---------------------------------------------------------------------------
// Mobile viewport: panel presents as sheet
// ---------------------------------------------------------------------------

test("TASK-431 mobile: panel presents as full-screen sheet on narrow viewport", async ({
  page,
}) => {
  const reviewRoot = process.env["REVIEW_ROOT_E2E"];
  if (!reviewRoot) {
    test.skip(true, "REVIEW_ROOT_E2E not set - setup.mjs did not run");
    return;
  }

  // Set a mobile viewport.
  await page.setViewportSize({ width: 390, height: 844 });

  const docPath = path.join(reviewRoot, "test-notes.md");
  const docParam = encodeURIComponent(docPath);
  await page.goto(`/threads/scribe?doc=${docParam}`);

  // The sheet (mobile overlay) should be visible.
  const sheet = page.getByTestId("review-panel-sheet");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(sheet).toContainText("Test Notes", { timeout: 5_000 });
});
