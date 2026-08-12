/**
 * ticket-lens.test.ts - TASK-445 ticket-thread lens E2E tests.
 *
 * Fixture ticket: TASK-432 is tagged on:
 *   - fixtures/inbox/scribe/inbox/alex.md block[1] (atlas "checking in")
 *   - fixtures/inbox/quill/inbox/alex.md block[0] (quill action card)
 * The fixture card fixtures/projects/task-432-projects-kanban.md is "in progress".
 *
 * Tests:
 *   LENS-01: ticket chip renders on tagged bubble; click navigates to /tickets/TASK-432.
 *   LENS-02: lens shows both messages chronologically with origin tags.
 *   LENS-03: lens shows the pinned card with correct column and board link.
 *   LENS-04: lens header has the correct Linear href.
 *   LENS-05: /tickets/NOT-A-TICKET -> 404.
 *   LENS-06: synergy column badge appears on a tagged bubble in the thread view.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import path from "node:path";
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers";

test.beforeEach(() => {
  resetFixtureInbox();
});

test.afterAll(() => assertGitClean(path.resolve(".")));

test("LENS-01: ticket chip renders on a tagged bubble and navigates to the lens", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // The atlas "checking in" block is tagged with TASK-432.
  // It renders as an agent bubble (own=false) with a ticket chip.
  const chip = page.getByTestId("bubble-ticket-chip").first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("TASK-432");

  // Click navigates to the lens route.
  await chip.click();
  await expect(page).toHaveURL(/\/tickets\/TASK-432/);
});

test("LENS-02: lens shows messages from both agents chronologically with origin tags", async ({
  page,
}) => {
  await page.goto("/tickets/TASK-432");

  // The header shows the ticket id.
  await expect(page.getByTestId("ticket-lens-header")).toHaveText("TASK-432");

  // Origin tags: both agents are represented.
  const originTags = page.getByTestId("ticket-lens-origin-tag");
  await expect(originTags).toHaveCount(2);

  // The quill block has timestamp 10:00, the scribe block (tagged TASK-432) has 15:00 -> quill first.
  // agentName is the inbox directory (the thread owner), not the block's from field.
  const tagTexts = await originTags.allTextContents();
  expect(tagTexts[0]).toBe("quill");
  expect(tagTexts[1]).toBe("scribe");
});

test("LENS-03: lens shows the pinned kanban card with column and board link", async ({
  page,
}) => {
  await page.goto("/tickets/TASK-432");

  // Pinned card is visible.
  const card = page.getByTestId("ticket-lens-card");
  await expect(card).toBeVisible();

  // Card title contains the ticket id.
  const title = page.getByTestId("ticket-lens-card-title");
  await expect(title).toBeVisible();
  await expect(title).toContainText("TASK-432");

  // Column badge shows "in progress".
  const colBadge = page.getByTestId("ticket-lens-card-column");
  await expect(colBadge).toHaveText("in progress");

  // "Open on board" link points to /projects?card=<id>.
  const boardLink = page.getByTestId("ticket-lens-open-on-board");
  await expect(boardLink).toBeVisible();
  const href = await boardLink.getAttribute("href");
  expect(href).toContain("/projects?card=task-432-projects-kanban.md");
});

test("LENS-04: lens header has the correct Linear link-out href", async ({
  page,
}) => {
  await page.goto("/tickets/TASK-432");

  const linearLink = page.getByTestId("ticket-lens-linear-link");
  await expect(linearLink).toBeVisible();
  const href = await linearLink.getAttribute("href");
  expect(href).toBe("https://linear.app/example-org/issue/TASK-432");
});

test("LENS-05: /tickets/NOT-A-TICKET returns 404", async ({ page }) => {
  const response = await page.goto("/tickets/NOT-A-TICKET");
  expect(response?.status()).toBe(404);
});

test("LENS-06: synergy column badge appears on a tagged bubble in the thread view", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // The TASK-432 card is "in progress", so the column badge should appear
  // beside the ticket chip on the tagged bubble.
  const colBadge = page.getByTestId("bubble-ticket-column-badge").first();
  await expect(colBadge).toBeVisible();
  await expect(colBadge).toHaveText("in progress");
});
