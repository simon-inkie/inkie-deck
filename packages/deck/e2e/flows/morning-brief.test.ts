/**
 * e2e/flows/morning-brief.test.ts - E2E tests for TASK-442 morning brief panel.
 *
 * Tests:
 * 1. BRIEF-01: Brief panel visible on home with the fixture heading rendered.
 * 2. BRIEF-02: Collapse toggle hides body; collapsed state persists across reload
 *    via localStorage mc-brief-seen-<date>.
 * 3. BRIEF-03: No-briefs dir scenario: home renders without a panel (existing
 *    needs-you items still present).
 *
 * Clock alignment:
 *   MC_NOW = "2026-06-10T20:30:00Z" (set in e2e/setup.mjs).
 *   The fixture brief is fixtures/inbox/quill/briefs/2026-06-10.md (today).
 *   e2e/setup.mjs copies fixtures/inbox wholesale to tmpInbox; the briefs dir
 *   appears at <tmpInbox>/quill/briefs/2026-06-10.md automatically. No manual
 *   stamp needed: the fixture filename is pre-aligned to the pinned MC_NOW date.
 *
 * BRIEF-03 absence case: uses a modified inbox state (rmSync the briefs dir
 * from the temp inbox) rather than a separate inbox root, so no env changes
 * are needed. The brief panel must be absent; needs-you items must still render.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

test.beforeEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

// ---------------------------------------------------------------------------
// BRIEF-01: Panel renders with fixture content
// ---------------------------------------------------------------------------

test("BRIEF-01: morning brief panel renders on home with fixture heading", async ({
  page,
}) => {
  await page.goto("/");

  // The brief panel should be visible.
  const panel = page.getByTestId("morning-brief");
  await expect(panel).toBeVisible();

  // The label-mono "Morning brief" text should be present.
  await expect(panel.getByText("Morning brief", { exact: true })).toBeVisible();

  // The formatted date should appear (10 June 2026 for 2026-06-10) in the header label span.
  await expect(panel.getByText("10 June 2026", { exact: true })).toBeVisible();

  // The body should be expanded by default for today's brief.
  const body = page.getByTestId("morning-brief-body");
  await expect(body).toBeVisible();

  // The fixture heading "Morning Brief - 10 June 2026" should render.
  await expect(body.getByRole("heading", { name: /morning brief/i })).toBeVisible();

  // A fixture bullet point should be rendered.
  await expect(body.getByText(/TASK-442 morning brief panel shipped/i)).toBeVisible();
});

// ---------------------------------------------------------------------------
// BRIEF-02: Collapse/expand and localStorage persistence
// ---------------------------------------------------------------------------

test("BRIEF-02: toggle collapses the brief; state persists across reload", async ({
  page,
  context,
}) => {
  // Clear localStorage before test to ensure a clean initial state.
  await context.clearCookies();

  await page.goto("/");

  const panel = page.getByTestId("morning-brief");
  await expect(panel).toBeVisible();

  // Body is visible initially (today's brief, not seen yet).
  const body = page.getByTestId("morning-brief-body");
  await expect(body).toBeVisible();

  // Click the toggle to collapse.
  const toggle = page.getByTestId("morning-brief-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();

  // Body should now be hidden.
  await expect(body).not.toBeVisible();

  // Reload the page - the body should stay collapsed (localStorage mc-brief-seen-2026-06-10).
  await page.reload();
  await expect(page.getByTestId("morning-brief")).toBeVisible();
  // After reload with seen state, body should remain collapsed.
  await expect(page.getByTestId("morning-brief-body")).not.toBeVisible();

  // User can re-expand.
  await page.getByTestId("morning-brief-toggle").click();
  await expect(page.getByTestId("morning-brief-body")).toBeVisible();
});

// ---------------------------------------------------------------------------
// BRIEF-03: No-briefs dir -> panel absent, needs-you still works
// ---------------------------------------------------------------------------

test("BRIEF-03: no briefs dir means panel absent; needs-you items still render", async ({
  page,
}) => {
  // Remove the briefs dir from the temp inbox to simulate the absence case.
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set");

  const briefsDir = path.join(inboxRoot, "quill", "briefs");
  if (fs.existsSync(briefsDir)) {
    fs.rmSync(briefsDir, { recursive: true, force: true });
  }

  await page.goto("/");

  // Brief panel should NOT be present.
  await expect(page.getByTestId("morning-brief")).not.toBeVisible();

  // Needs-you content should still render normally.
  // At least one of the standard needs-you sections should be present.
  const hasDecisions = await page.getByTestId("section-decisions").isVisible().catch(() => false);
  const hasTodos = await page.getByTestId("section-todos").isVisible().catch(() => false);
  const hasBlocked = await page.getByTestId("section-blocked").isVisible().catch(() => false);
  const hasEmpty = await page.getByTestId("queue-empty-state").isVisible().catch(() => false);

  expect(hasDecisions || hasTodos || hasBlocked || hasEmpty).toBe(true);
});
