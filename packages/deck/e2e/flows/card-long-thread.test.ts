/**
 * card-long-thread.test.ts - Alex's live repro, on a LONG thread.
 *
 * Alex: summit thread (short) cards work, but a decision card deep in the quill
 * thread (long, ~2000 lines) misbehaves - "clicked C and it went to A",
 * "can't choose after I've typed". This test reproduces the interaction on a
 * synthetic ~100-message thread on the CURRENT build, to settle whether the bug
 * is length-dependent and present WITHOUT the (reverted) memo, or whether it was
 * the memo all along (in which case this passes clean and Alex was on a stale
 * cached build).
 *
 * The distilled repro = the assertion: tap "OR write something" (C path), type a
 * custom answer, then tap option A -> A must be the resolved option (not C, not
 * dead). This is also the gate for TASK-466 (the Markdown-only memo re-do).
 *
 * VALID-03: seeds + writes only under INBOX_ROOT (temp). ASCII only (FND-05).
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

// Restore the canonical fixtures after each test - this suite OVERWRITES the
// scribe inbox with a synthetic long thread, and leaving it would pollute other
// files that share INBOX_ROOT (e.g. card-render expects the original fixture).
test.afterEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

function seedLongThread(agent: string, padCount: number) {
  const inboxRoot = process.env["INBOX_ROOT"];
  if (!inboxRoot) throw new Error("INBOX_ROOT not set");
  const dir = path.join(inboxRoot, agent, "inbox");
  fs.mkdirSync(dir, { recursive: true });

  let out = "";
  for (let i = 0; i < padCount; i++) {
    const from = i % 2 === 0 ? agent : "alex";
    out += `## 2026-06-09T09:${String(i % 60).padStart(2, "0")}:00Z - from: ${from} - status: read - subject: history ${i}\n`;
    // A code fence every few blocks so the markdown render cost is realistic.
    out += i % 5 === 0
      ? "Padding line with `inline code` and a [link](/x.md).\n\n```ts\nconst n = " + i + ";\n```\n\n---\n"
      : `Padding message number ${i} to make the thread long.\n\n---\n`;
  }
  // The unanswered decision card at the end of the long thread.
  out += `## 2026-06-10T10:00:00Z - from: ${agent} - status: sent - subject: Long-thread decision card
decision-id: long-thread-card
options:
  - key: A
    label: "Option A - the one we tap last"
    detail: "After typing a custom answer, tapping this must resolve to A."
  - key: B
    label: "Option B"
    detail: "Other canned option."

Body of the decision card at the bottom of a long thread.

---
`;
  fs.writeFileSync(path.join(dir, "alex.md"), out, "utf8");
}

test("long thread: tap C (write-own) -> type -> tap option A resolves to A (not C, not dead)", async ({ page }) => {
  resetFixtureInbox();
  seedLongThread("scribe", 100);

  await page.goto("/threads/scribe");
  const card = page.locator('[data-testid="decision-card"]').first();
  await expect(card).toBeVisible();

  // C path: open write-own, type a custom answer (do NOT submit).
  await card.getByTestId("write-own-btn").click();
  const textarea = page.getByTestId("compose-textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("a custom answer I will abandon");

  // Now change my mind and tap option A.
  await page.getByRole("button", { name: /Option A - the one we tap last/ }).click();

  // The card must resolve to A - the chip carries the A label, not C, not dead.
  const chip = card.getByTestId("decision-resolution-chip");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText("Answered:");

  // Writeback must record answer A (the regression: a stale render could submit C
  // or the abandoned custom text instead).
  const inboxFile = path.join(process.env["INBOX_ROOT"]!, "scribe", "inbox", "alex.md");
  const content = fs.readFileSync(inboxFile, "utf8");
  expect(content).toContain("answer: A");
  expect(content).not.toContain("a custom answer I will abandon");
});
