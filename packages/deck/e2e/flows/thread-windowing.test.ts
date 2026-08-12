/**
 * thread-windowing.test.ts - TASK-469 chunked lazy-load on the thread view.
 *
 * Proves the three user-visible behaviours of the windowing:
 *   1. A long thread initially renders only the tail window (~30 blocks),
 *      not the whole file - with the load-older sentinel present.
 *   2. Scrolling the sentinel into view prepends the previous chunk, and
 *      already-loaded messages stay mounted.
 *   3. A deep link (#decisionId) to a card OUTSIDE the initial window still
 *      lands on the card (Summit contract line 3): the client re-requests
 *      with ?anchor= and the loader extends the window back to the target.
 *
 * Seeds a synthetic long thread in the scribe inbox (same pattern as
 * card-long-thread.test.ts) and restores the canonical fixtures after each
 * test. VALID-03: writes only under INBOX_ROOT (temp). ASCII only (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

/**
 * Seed `padCount` plain messages, optionally preceded by a decision card as
 * block 0 (cardFirst). Message bodies are uniquely greppable:
 * "Padding message number <i> to make the thread long."
 */
function seedLongThread(agent: string, padCount: number, opts: { cardFirst?: boolean } = {}) {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set");
  const dir = path.join(inboxRoot, agent, "inbox");
  fs.mkdirSync(dir, { recursive: true });

  let out = "";
  if (opts.cardFirst) {
    out += `## 2026-06-09T08:00:00Z - from: ${agent} - status: sent - subject: Early decision card
decision-id: early-card
options:
  - key: A
    label: "Option A - early"
    detail: "The card buried at the top of a long thread."
  - key: B
    label: "Option B - early"
    detail: "Other option."

Decision card at the very top of the thread - outside the initial window.

---
`;
  }
  for (let i = 0; i < padCount; i++) {
    const from = i % 2 === 0 ? agent : "alex";
    const hour = String(9 + Math.floor(i / 60)).padStart(2, "0");
    const minute = String(i % 60).padStart(2, "0");
    out += `## 2026-06-09T${hour}:${minute}:00Z - from: ${from} - status: read - subject: history ${i}\n`;
    out += `Padding message number ${i} to make the thread long.\n\n---\n`;
  }
  fs.writeFileSync(path.join(dir, "alex.md"), out, "utf8");
}

test("long thread renders only the tail window, then lazy-loads older on scroll-up", async ({ page }) => {
  resetFixtureInbox();
  seedLongThread("scribe", 100);

  await page.goto("/threads/scribe");

  // Scope to the thread pane - the sidebar's latest-message preview would
  // otherwise also match the tail message text (strict mode).
  const pane = page.getByTestId("thread-scroll");

  // The tail is rendered...
  await expect(
    pane.getByText("Padding message number 99 to make the thread long.")
  ).toBeVisible();
  // ...but the head of the thread is NOT in the DOM (windowed, last 30 only).
  await expect(
    pane.getByText("Padding message number 5 to make the thread long.")
  ).toHaveCount(0);
  // Block 69 sits just outside the [70, 100) window.
  await expect(
    pane.getByText("Padding message number 69 to make the thread long.")
  ).toHaveCount(0);

  // The load-older sentinel is present (older history exists).
  const sentinel = page.getByTestId("load-older-sentinel");
  await expect(sentinel).toBeAttached();

  // Scroll the sentinel into view - the previous chunk [40, 70) prepends.
  await sentinel.scrollIntoViewIfNeeded();
  await expect(
    pane.getByText("Padding message number 69 to make the thread long.")
  ).toBeAttached({ timeout: 10_000 });
  await expect(
    pane.getByText("Padding message number 40 to make the thread long.")
  ).toBeAttached();

  // Already-loaded tail messages stay mounted after the prepend.
  await expect(
    pane.getByText("Padding message number 99 to make the thread long.")
  ).toBeAttached();
});

test("deep link to a card outside the initial window extends the window and lands on it", async ({ page }) => {
  resetFixtureInbox();
  seedLongThread("scribe", 99, { cardFirst: true });

  await page.goto("/threads/scribe#early-card");

  // The client detects the miss, re-requests with ?anchor=early-card, the
  // loader extends the window back to the card, and the view scrolls to it.
  const card = page.getByTestId("decision-card");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toBeInViewport({ timeout: 10_000 });
  await expect(page).toHaveURL(/anchor=early-card/);

  // The card is still interactive out there: option labels render.
  await expect(page.getByRole("button", { name: /Option A - early/ })).toBeVisible();
});
