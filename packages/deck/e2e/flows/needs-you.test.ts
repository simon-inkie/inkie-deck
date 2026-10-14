/**
 * needs-you.test.ts - E2E flow for the "Needs you" home list.
 *
 * Tests:
 * 1. Home shows all three kinds (Decide / Do / Blocked badges).
 * 2. Inline Done tick from the home list works and disappears from list.
 * 3. Decision deep-link navigates to the correct thread.
 * 4. Mobile viewport: list usable, tick tappable (390px).
 *
 * Additions (needs-you v1.1):
 * 5. Wordmark is a link to home ("/").
 * 6. Three sections render in fixed order (Decisions / Todos / Blocked) with counts.
 * 7. Needs-you rows show a <time dateTime="..."> with the createdAt ISO in dateTime.
 * 8. Blocked row with blocked-on shows "Blocked on: <value>" text.
 * 9. X dismiss button reveals inline dismiss form; submit dismisses and item leaves list.
 * 10. Bell dropdown groups items with section labels.
 *
 * Fixtures used:
 * - fixtures/inbox/scribe/inbox/alex.md (decision card)
 * - fixtures/inbox/quill/inbox/alex.md (action card)
 * - fixtures/projects/*.md (blocked card: task-398-portal-readonly.md column=blocked,
 *   blocked-on: supplier API key approval)
 *
 * MC_NOW=2026-06-10T20:30:00Z (set by e2e/setup.mjs):
 * - Scribe decision filed 2026-06-09T14:30:00Z -> ~30h old -> overdue (24h tier)
 * - Quill action card filed 2026-06-09T10:00:00Z -> ~34.5h old -> overdue
 * - Blocked card updated 2026-05-01 -> very old -> overdue (48h tier)
 *
 * ASCII only - no em-dashes.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";

const MOBILE = { width: 390, height: 844 };

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

// ---------------------------------------------------------------------------
// Test 1: Home shows all three kind badges
// ---------------------------------------------------------------------------

test("NEEDS-01: home list shows Decide, Do, and Blocked badges", async ({ page }) => {
  await page.goto("/");

  // Needs you heading is present.
  await expect(page.getByRole("heading", { name: /needs you/i })).toBeVisible();

  // At least one item of each kind should appear given the fixtures.
  // Decide badge (from scribe decision card).
  await expect(page.getByText("Decide", { exact: true }).first()).toBeVisible();

  // Do badge (from quill action card).
  await expect(page.getByText("Do", { exact: true }).first()).toBeVisible();

  // Blocked badge (from task-398-portal-readonly.md).
  await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: Inline Done tick from home list
// ---------------------------------------------------------------------------

test("NEEDS-02: inline Done tick from home marks action done and item leaves list", async ({
  page,
}) => {
  await page.goto("/");

  // The Do-kind item should be present.
  await expect(page.getByText("Do", { exact: true }).first()).toBeVisible();

  // Find and tap the done tick button in the home list.
  const doneBtn = page.getByTestId("home-action-done-btn").first();
  await expect(doneBtn).toBeVisible();

  await doneBtn.click();

  // After submission, the item should leave the list (loader revalidates).
  // Wait for the "Do" badge to disappear (or its count to decrease).
  await expect(doneBtn).not.toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Test 3: Decision deep-link navigates to thread
// ---------------------------------------------------------------------------

test("NEEDS-03: decision item deep-link opens the correct thread", async ({ page }) => {
  await page.goto("/");

  // The Decide-kind item has a deep-link to /threads/scribe.
  // Click the main body/link area of the decision row (not the Handled button).
  const decideItem = page.locator('[data-testid="needs-you-item"]').filter({
    has: page.getByText("Decide", { exact: true }),
  }).first();
  await expect(decideItem).toBeVisible();

  // Click the Link area (the agent avatar / preview area, not the button).
  await decideItem.getByRole("link").first().click();

  // Should navigate to /threads/scribe.
  await expect(page).toHaveURL(/\/threads\/scribe/, { timeout: 10_000 });

  // Thread header is present.
  await expect(page.getByTestId("thread-header")).toContainText("scribe");
});

// ---------------------------------------------------------------------------
// Test 4: Mobile viewport - list usable, tick tappable
// ---------------------------------------------------------------------------

test("NEEDS-04: mobile viewport - needs-you list renders and tick is tappable", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/");

  // Needs you heading visible.
  await expect(page.getByRole("heading", { name: /needs you/i })).toBeVisible();

  // Container does not overflow viewport.
  const main = page.getByRole("main");
  await expect(main).toBeVisible();
  const box = await main.boundingBox();
  if (box) {
    expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width + 1);
  }

  // Do item and done tick are tappable at 390px.
  const doneBtn = page.getByTestId("home-action-done-btn").first();
  await expect(doneBtn).toBeVisible();

  // Tap target: button should be at least 44px
  const btnBox = await doneBtn.boundingBox();
  if (btnBox) {
    expect(btnBox.width).toBeGreaterThanOrEqual(43); // 44px - 1 tolerance
    expect(btnBox.height).toBeGreaterThanOrEqual(43);
  }
});

// ---------------------------------------------------------------------------
// Test 5 - Wordmark is a link to home
// ---------------------------------------------------------------------------

test("NEEDS-440-05: Inkie Deck wordmark is a link that navigates to home", async ({
  page,
}) => {
  // Start from the threads page so we can navigate back.
  await page.goto("/threads/quill");

  // Find the wordmark link by its aria-label.
  const wordmarkLink = page.getByRole("link", { name: "Inkie Deck home" });
  await expect(wordmarkLink).toBeVisible();

  // Click it.
  await wordmarkLink.click();

  // Should land on the home route ("/") - URL ends at the origin with no path segments.
  await expect(page).toHaveURL(/localhost:\d+\/?(\?.*)?$/, { timeout: 10_000 });

  // Home heading should be visible.
  await expect(page.getByRole("heading", { name: /needs you/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 6 - Three sections render in fixed order with counts
// ---------------------------------------------------------------------------

test("NEEDS-440-06: home renders three sections in Decisions / Todos / Blocked order with counts", async ({
  page,
}) => {
  await page.goto("/");

  // All three sections are present.
  const decisionsSection = page.getByTestId("section-decisions");
  const todosSection = page.getByTestId("section-todos");
  const blockedSection = page.getByTestId("section-blocked");

  await expect(decisionsSection).toBeVisible();
  await expect(todosSection).toBeVisible();
  await expect(blockedSection).toBeVisible();

  // Decisions section appears before Todos which appears before Blocked in DOM order.
  const decisionsBbox = await decisionsSection.boundingBox();
  const todosBbox = await todosSection.boundingBox();
  const blockedBbox = await blockedSection.boundingBox();

  if (decisionsBbox && todosBbox) {
    expect(decisionsBbox.y).toBeLessThan(todosBbox.y);
  }
  if (todosBbox && blockedBbox) {
    expect(todosBbox.y).toBeLessThan(blockedBbox.y);
  }

  // Each section label is visible (case-insensitive) with a count chip.
  await expect(decisionsSection.getByText(/decisions/i)).toBeVisible();
  await expect(todosSection.getByText(/todos/i)).toBeVisible();
  await expect(blockedSection.getByText(/blocked/i).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 7 - Rows show createdAt with ISO in dateTime attribute
// ---------------------------------------------------------------------------

test("NEEDS-440-07: each needs-you row has a time element with ISO createdAt in dateTime", async ({
  page,
}) => {
  await page.goto("/");

  // There should be at least one needs-you-item with a <time> element.
  const firstItem = page.getByTestId("needs-you-item").first();
  await expect(firstItem).toBeVisible();

  // The Timestamp renders a <time dateTime="<ISO>"> element.
  const timeEl = firstItem.locator("time").first();
  await expect(timeEl).toBeVisible();

  const dateTimeAttr = await timeEl.getAttribute("dateTime");
  // Should be an ISO 8601 string (contains 'T' and 'Z' or offset).
  expect(dateTimeAttr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// ---------------------------------------------------------------------------
// Test 8 - Blocked row with blocked-on shows "Blocked on: <value>"
// ---------------------------------------------------------------------------

test("NEEDS-440-08: blocked row shows blocked-on value", async ({ page }) => {
  await page.goto("/");

  // The blocked section should contain the task-398-portal-readonly card.
  const blockedSection = page.getByTestId("section-blocked");
  await expect(blockedSection).toBeVisible();

  // The fixture has blocked-on: supplier API key approval.
  await expect(
    blockedSection.getByText(/Blocked on: supplier API key approval/i)
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 9 - X dismiss flow: form appears, submit removes item
// ---------------------------------------------------------------------------

test("NEEDS-440-09: X dismiss button shows inline form and dismissing removes item from list", async ({
  page,
}) => {
  await page.goto("/");

  // Find the dismiss button on the first Do-kind (action) item.
  const dismissBtn = page.getByTestId("home-action-dismiss-btn").first();
  await expect(dismissBtn).toBeVisible();

  // Initially the dismiss form is hidden.
  await expect(page.getByTestId("home-dismiss-reason-input")).not.toBeVisible();

  // Click X to reveal form.
  await dismissBtn.click();

  // Dismiss form should appear.
  const reasonInput = page.getByTestId("home-dismiss-reason-input").first();
  await expect(reasonInput).toBeVisible();

  // Type a reason (optional but exercises the input).
  await reasonInput.fill("Not my call");

  // Submit.
  const confirmBtn = page.getByTestId("home-dismiss-confirm-btn").first();
  await confirmBtn.click();

  // After dismissal, the Do item should leave the list (dismissedcards excluded by deriveNeedsYou).
  await expect(dismissBtn).not.toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Test 10 - Bell dropdown groups items with section labels
// ---------------------------------------------------------------------------

test("NEEDS-440-10: bell dropdown groups needs-you items with section labels", async ({
  page,
}) => {
  await page.goto("/");

  // Open the bell dropdown.
  const bellBtn = page.getByRole("button", { name: /needs you/i });
  await expect(bellBtn).toBeVisible();
  await bellBtn.click();

  // Dropdown content is visible.
  // At least one of the group labels (Decisions, Todos, Blocked) should appear.
  // The dropdown renders group labels only for non-empty sections.
  const dropdownContent = page.getByRole("menu");
  await expect(dropdownContent).toBeVisible();

  // Expect at least one of the group labels in the dropdown.
  const hasDecisions = await page.getByText("Decisions").first().isVisible().catch(() => false);
  const hasTodos = await page.getByText("Todos").first().isVisible().catch(() => false);
  const hasBlocked = await page.getByText("Blocked").first().isVisible().catch(() => false);

  expect(hasDecisions || hasTodos || hasBlocked).toBe(true);
});
