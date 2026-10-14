/**
 * card-placeholder-buried.test.ts - regression suite for the
 * "clicking doesn't work" bug (two stacked causes):
 *
 *   1. Cards authored with EMPTY answered:/custom-answer: template
 *      placeholders made every tap a silent alreadyAnswered no-op (the
 *      apply* guards matched the placeholder; parse did not). The operator's 5
 *      stuck decisions were exactly this shape.
 *   2. A card BELOW the live window renders from the client's retained map,
 *      which loader revalidation never refreshed - so even a landed answer
 *      left the stale unanswered copy on screen (tap looked dead).
 *
 * These are INTERACTION tests by design: the earlier memoisation saga proved a
 * render-only e2e passes while taps are broken, so always tap and assert the
 * submitted state.
 *
 * Writes only under INBOX_ROOT (temp). ASCII only.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

/**
 * Seed a thread whose FIRST block is a decision card in the placeholder
 * template shape (empty answered:/custom-answer: lines), followed by
 * `padCount` plain messages so the card sits outside the ~30-block tail
 * window when padCount is large.
 */
function seedPlaceholderCardThread(agent: string, padCount: number) {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set");
  const dir = path.join(inboxRoot, agent, "inbox");
  fs.mkdirSync(dir, { recursive: true });

  let out = `## 2026-06-09T08:00:00Z - from: ${agent} - status: read - subject: Placeholder-template decision
decision-id: placeholder-card
options:
  - key: A
    label: "Option A - placeholder shape"
    detail: "Tapping this must resolve the card."
  - key: B
    label: "Option B - placeholder shape"
    detail: "Other option."
lean: A
answered:
custom-answer:

A card authored with empty template placeholders - the 2026-06-11 stuck-card shape.

---
`;
  for (let i = 0; i < padCount; i++) {
    const from = i % 2 === 0 ? agent : "alex";
    const hour = String(9 + Math.floor(i / 60)).padStart(2, "0");
    const minute = String(i % 60).padStart(2, "0");
    out += `## 2026-06-09T${hour}:${minute}:00Z - from: ${from} - status: read - subject: history ${i}\n`;
    out += `Padding message number ${i} to make the thread long.\n\n---\n`;
  }
  fs.writeFileSync(path.join(dir, "alex.md"), out, "utf8");
}

test("placeholder-template card resolves on tap (apply-guard regression)", async ({ page }) => {
  resetFixtureInbox();
  // Short thread: the card is inside the live window - isolates cause 1.
  seedPlaceholderCardThread("scribe", 3);

  await page.goto("/threads/scribe");

  const card = page.locator("#placeholder-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /Option A - placeholder shape/ }).click();

  // The card flips to a resolved receipt - NOT a silent no-op.
  await expect(card.getByTestId("decision-resolution-chip")).toBeVisible({ timeout: 10_000 });

  // The answer landed in the temp fixture exactly once (placeholder filled
  // in place; a duplicate "answered:" key would poison the next parse).
  const inboxFile = path.join(process.env["INBOX_ROOT"]!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  const cardSegment = /decision-id: placeholder-card[\s\S]*?---/.exec(content)![0];
  const answeredLines = cardSegment.match(/^answered:.*$/gm) || [];
  expect(answeredLines).toEqual(["answered: A"]);
});

test("buried placeholder card reached by scroll-up resolves on tap (retained-refresh regression)", async ({ page }) => {
  resetFixtureInbox();
  // Long thread: the card sits outside the tail window - exercises cause 2.
  seedPlaceholderCardThread("scribe", 60);

  await page.goto("/threads/scribe");
  const pane = page.getByTestId("thread-scroll");
  await expect(pane).toBeVisible();

  // Scroll to the top repeatedly until the lazy-loader has mounted the card.
  const card = page.locator("#placeholder-card");
  for (let i = 0; i < 40; i++) {
    if ((await card.count()) > 0) break;
    await pane.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
  }
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: /Option A - placeholder shape/ }).click();

  // The retained below-window copy must refresh: the card flips to the
  // resolved receipt instead of keeping live option buttons forever.
  await expect(card.getByTestId("decision-resolution-chip")).toBeVisible({ timeout: 10_000 });
  await expect(
    card.getByRole("button", { name: /Option A - placeholder shape/ })
  ).not.toBeVisible();

  const inboxFile = path.join(process.env["INBOX_ROOT"]!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  const cardSegment = /decision-id: placeholder-card[\s\S]*?---/.exec(content)![0];
  const answeredLines = cardSegment.match(/^answered:.*$/gm) || [];
  expect(answeredLines).toEqual(["answered: A"]);
});
