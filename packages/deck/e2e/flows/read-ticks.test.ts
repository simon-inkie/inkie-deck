/**
 * read-ticks.test.ts - TASK-443/TASK-444 read receipts and working indicator.
 *
 * The scribe fixture thread carries four from-alex blocks:
 *   - status: read ("re: checking in") -> double tick
 *   - status: sent ("one more thing") -> single tick
 *   - status: working superseded ("working superseded") -> double tick (read fallback)
 *   - status: working live ("live working", last block) -> working indicator, no tick
 *
 * Own bubbles show the tick cluster (single tick = sent, double = read);
 * working+superseded -> double tick; working+live -> spinner + label.
 * Agent bubbles carry no ticks v1.
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

test("TICK-01: own bubbles show sent and read ticks; agent bubbles show none", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // Three tick elements: read ("re: checking in"), sent ("one more thing"),
  // and read (superseded working block). TASK-444: working+superseded -> read tick.
  const ticks = page.getByTestId("bubble-status-tick");
  await expect(ticks).toHaveCount(3);

  // Two read (double tick), one sent (single tick).
  await expect(
    page.locator('[data-testid="bubble-status-tick"][data-status="read"]')
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="bubble-status-tick"][data-status="sent"]')
  ).toHaveCount(1);

  // Accessible labels carry the receipt meaning.
  const readTicks = page.locator('[data-testid="bubble-status-tick"][data-status="read"]');
  await expect(readTicks.first()).toHaveAttribute("aria-label", "Read");
  await expect(
    page.locator('[data-testid="bubble-status-tick"][data-status="sent"]')
  ).toHaveAttribute("aria-label", "Sent");

  // Agent bubbles carry no ticks: MessageBubble renders agent blocks with
  // items-start alignment (own blocks are items-end) - no tick may appear
  // inside any items-start bubble container.
  await expect(
    page.locator('div.items-start [data-testid="bubble-status-tick"]')
  ).toHaveCount(0);
});

test("TICK-02: live working block shows spinner indicator; superseded shows double tick", async ({
  page,
}) => {
  await page.goto("/threads/scribe");

  // Live working block (last alex block, no agent reply after it): spinner visible.
  const workingIndicator = page.getByTestId("bubble-status-working");
  await expect(workingIndicator).toHaveCount(1);
  // The fixture's live working block is ~29h old at the e2e clock, so the
  // stale-working disclosure (Atlas fold) appends the SENT age to the label.
  await expect(workingIndicator).toHaveAttribute(
    "aria-label",
    /^scribe is on this - sent .+ ago$/
  );

  // Superseded working block (agent replied after it): renders as read tick, no indicator.
  // The working indicator count is exactly 1 (only the live block).
  // The superseded working block contributes to the 2 read ticks above (TICK-01).
  await expect(workingIndicator).toBeVisible();

  // Working indicator is only on own (items-end) bubbles.
  await expect(
    page.locator('div.items-start [data-testid="bubble-status-working"]')
  ).toHaveCount(0);
});
