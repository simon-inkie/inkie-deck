/**
 * e2e/flows/card-detail.test.ts - E2E tests for TASK-439 card detail + work strip.
 *
 * Tests per plan section 4:
 *   - Board face: summary line visible under title.
 *   - Card click: detail renders body markdown + meta; URL carries ?card=;
 *     refresh keeps it; close clears.
 *   - .md link in detail body: review panel opens on /projects with ?doc= set
 *     and ?card= RETAINED; closing the panel restores the detail (Atlas fold).
 *   - Thread strip: agent with cards shows the strip with column badges;
 *     click -> /projects?card=; agent without cards shows no strip.
 *   - Mobile viewport: detail is a sheet; strip scrolls.
 *
 * Workers stay 1 per playwright.config.ts.
 * Uses assertGitClean from helpers (VALID-03).
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { test, expect } from "@playwright/test";
import { assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterAll(() => assertGitClean(path.resolve(".")));

// ---------------------------------------------------------------------------
// Board face: summary line visible under the title
// ---------------------------------------------------------------------------

test("TASK-439 board face: summary line visible under card title", async ({ page }) => {
  await page.goto("/projects");

  // task-439-card-detail.md has a body; its summary should appear on the board.
  const card = page.getByTestId("card-task-439-card-detail.md");
  await expect(card).toBeVisible();

  const summary = page.getByTestId("card-summary-task-439-card-detail.md");
  await expect(summary).toBeVisible();
  // Summary is derived from the first body paragraph.
  await expect(summary).toContainText("Card detail overlay");
});

// ---------------------------------------------------------------------------
// Card click -> detail overlay, URL state, refresh persistence, close
// ---------------------------------------------------------------------------

test("TASK-439 card click opens detail; URL carries ?card=; refresh keeps it; close clears", async ({
  page,
}) => {
  await page.goto("/projects");

  // Click the card open button on task-439-card-detail.md.
  const openBtn = page.getByTestId("card-open-task-439-card-detail.md");
  await expect(openBtn).toBeVisible();
  await openBtn.click();

  // Desktop dialog should be visible (md+ viewport).
  const dialog = page.getByTestId("card-detail-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Detail shows the title - scoped to the dialog to avoid strict-mode violation
  // (both sheet + dialog render the same testid; CSS hides one based on viewport).
  await expect(dialog.getByTestId("card-detail-title")).toContainText("TASK-439");

  // Detail shows the body (rendered as markdown).
  const body = dialog.getByTestId("card-detail-body");
  await expect(body).toBeVisible();
  await expect(body).toContainText("Card detail overlay");

  // URL carries ?card= param.
  const url = new URL(page.url());
  expect(url.searchParams.get("card")).toBe("task-439-card-detail.md");

  // Refresh keeps the detail open.
  await page.reload();
  const dialogAfterReload = page.getByTestId("card-detail-dialog");
  await expect(dialogAfterReload).toBeVisible({ timeout: 10_000 });

  // Close clears the param and closes the detail.
  // Use the first close button (dialog and sheet both have one; dialog is the visible one).
  await dialog.getByTestId("card-detail-close").click();
  await expect(page.getByTestId("card-detail-dialog")).not.toBeVisible({ timeout: 5_000 });
  const urlAfterClose = new URL(page.url());
  expect(urlAfterClose.searchParams.has("card")).toBe(false);
});

// ---------------------------------------------------------------------------
// .md link in detail body -> panel opens, ?card= retained, close restores detail
// ---------------------------------------------------------------------------

test("TASK-439 body .md link click opens review panel on /projects", async ({ page }) => {
  const reviewRoot = process.env["REVIEW_ROOT_E2E"];
  if (!reviewRoot) {
    test.skip(true, "REVIEW_ROOT_E2E not set - setup.mjs did not run");
    return;
  }

  await page.goto("/projects?card=task-439-card-detail.md");

  // Detail should be open (desktop dialog at md+ viewport).
  const dialog = page.getByTestId("card-detail-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("card-detail-body")).toBeVisible();

  // Test via the links: chip row (chips are ReviewableChip -> panel on click).
  const linksRow = dialog.getByTestId("card-detail-links");
  await expect(linksRow).toBeVisible({ timeout: 5_000 });

  // Click the first chip to open the review panel.
  const chip = dialog.getByTestId("card-detail-link-chip").first();
  await expect(chip).toBeVisible();
  await chip.click();

  // Review panel should open.
  const panel = page.getByTestId("review-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("TASK-439 Test Plan", { timeout: 5_000 });

  // RETAINED-PARAM rule (Atlas fold): ?doc= set AND ?card= retained -
  // the doc-wins precedence hides the detail while the panel is open.
  const url = new URL(page.url());
  expect(url.searchParams.has("doc")).toBe(true);
  expect(url.searchParams.get("card")).toBe("task-439-card-detail.md");
  await expect(dialog).not.toBeVisible();

  // Close the panel: detail RESTORES, URL carries ?card= only.
  await page.getByRole("button", { name: "Close review panel" }).first().click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByTestId("card-detail-dialog")).toBeVisible({ timeout: 5_000 });
  const urlAfter = new URL(page.url());
  expect(urlAfter.searchParams.has("doc")).toBe(false);
  expect(urlAfter.searchParams.get("card")).toBe("task-439-card-detail.md");
});

// ---------------------------------------------------------------------------
// Thread strip: agent with cards shows strip; agent without cards shows none
// ---------------------------------------------------------------------------

test("TASK-439 thread strip: summit has live cards -> strip visible with badge", async ({
  page,
}) => {
  // summit has task-439-card-detail.md (in progress) and
  // task-432-projects-kanban.md (in progress) and pinterest-api-spike.md (todo).
  await page.goto("/threads/summit");
  await expect(page.getByTestId("thread-header")).toContainText("summit");

  // TASK-454: the strip lives in the slide-out work panel now - the top-bar
  // trigger (badged with the live-card count) opens it.
  const trigger = page.getByTestId("work-strip-trigger");
  await expect(trigger).toBeVisible({ timeout: 5_000 });
  await trigger.click();

  const panel = page.getByTestId("work-strip-panel");
  await expect(panel).toBeVisible();
  const strip = page.getByTestId("work-strip");
  await expect(strip).toBeVisible();

  // At least one mini-card should be present for summit's non-done cards.
  // task-432-projects-kanban.md is one.
  const miniCard = page.getByTestId("work-strip-card-task-432-projects-kanban.md");
  await expect(miniCard).toBeVisible();
});

test("TASK-439 thread strip: mini-card link navigates to /projects?card=", async ({
  page,
}) => {
  await page.goto("/threads/summit");

  // TASK-454: open the work panel first.
  await page.getByTestId("work-strip-trigger").click();
  const miniCard = page.getByTestId("work-strip-card-task-432-projects-kanban.md");
  await expect(miniCard).toBeVisible({ timeout: 5_000 });

  // Clicking navigates to /projects?card=<id> (and closes the panel).
  await miniCard.click();
  await expect(page).toHaveURL(/\/projects\?card=task-432-projects-kanban\.md/, {
    timeout: 5_000,
  });

  // Detail overlay should open.
  const dialog = page.getByTestId("card-detail-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
});

test("TASK-439 thread strip: agent without live cards shows no strip", async ({ page }) => {
  // scribe has no project cards in the seeded fixtures.
  await page.goto("/threads/scribe");
  await expect(page.getByTestId("thread-header")).toContainText("scribe");

  // TASK-454: no live cards -> no panel trigger, and no strip anywhere.
  await expect(page.getByTestId("work-strip-trigger")).not.toBeVisible({ timeout: 5_000 });
  const strip = page.getByTestId("work-strip");
  await expect(strip).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Mobile viewport: detail is a sheet; strip scrolls
// ---------------------------------------------------------------------------

test("TASK-439 mobile: card detail opens as sheet on narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/projects");

  const openBtn = page.getByTestId("card-open-task-439-card-detail.md");
  await expect(openBtn).toBeVisible();
  await openBtn.click();

  // Mobile sheet should be visible.
  const sheet = page.getByTestId("card-detail-sheet");
  await expect(sheet).toBeVisible({ timeout: 5_000 });
  await expect(sheet).toContainText("TASK-439");
});

test("TASK-454 mobile: work panel opens from the trigger on narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/threads/summit");

  await page.getByTestId("work-strip-trigger").click();
  const panel = page.getByTestId("work-strip-panel");
  await expect(panel).toBeVisible({ timeout: 5_000 });

  const strip = page.getByTestId("work-strip");
  await expect(strip).toBeVisible();
  const firstCard = strip.locator('[data-testid^="work-strip-card-"]').first();
  await expect(firstCard).toBeVisible();
});
