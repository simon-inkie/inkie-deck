/**
 * sidebar-dot.test.ts - the agent-list "needs attention" dot.
 *
 * The dot was stuck on for quill + summit and never appeared for
 * other agents. Root cause: the dot read raw card state (answered/done) and
 * ignored BOTH (a) the queue-store handled set, so a swept card kept the dot
 * lit, and (b) unread plain messages, so a chatty agent never dotted.
 *
 * Two distinct dots: a MAGENTA dot for an unread message and a
 * BURNT-ORANGE dot for an open (un-swept) decision/action card. Both can show
 * at once. A swept card shows no decision dot. This suite pins all the cases.
 *
 * Writes only under INBOX_ROOT + the tmp queue store. ASCII only.
 */
import { test, expect } from "@playwright/test";
import { resetFixtureInbox, assertGitClean } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";

test.afterEach(() => resetFixtureInbox());
test.afterAll(() => assertGitClean(path.resolve(".")));

function writeThread(agent: string, body: string) {
  const dir = path.join(process.env["INBOX_ROOT"]!, agent, "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "alex.md"), body, "utf8");
}

/** A plain message block. */
function msg(from: string, ts: string, status: "sent" | "read", subject: string) {
  return `## ${ts} - from: ${from} - status: ${status} - subject: ${subject}\n\nBody.\n\n---\n`;
}

/** An unanswered decision card block (status read so it is not also "unread"). */
function cardBlock(from: string, ts: string, decisionId: string) {
  return [
    `## ${ts} - from: ${from} - status: read - subject: Decision ${decisionId}`,
    `decision-id: ${decisionId}`,
    `options:`,
    `  - key: A`,
    `    label: "Yes"`,
    `    detail: ""`,
    `  - key: B`,
    `    label: "No"`,
    `    detail: ""`,
    ``,
    `Body.`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

test("dot reflects unread messages and un-swept cards, not swept cards", async ({ page }) => {
  resetFixtureInbox();

  // read-msg: a read message, no cards -> NO dot.
  writeThread("readmsg", msg("readmsg", "2026-06-12T10:00:00Z", "read", "all caught up"));
  // unreadmsg: an unread message from the agent -> dot (the "other agents" fix).
  writeThread("unreadmsg", msg("unreadmsg", "2026-06-12T10:00:00Z", "sent", "new thing"));
  // opencard: an unanswered card NOT in the handled set -> dot.
  writeThread("opencard", cardBlock("opencard", "2026-06-12T09:00:00Z", "OPEN-Q"));
  // sweptcard: an unanswered card that IS swept (handled) -> NO dot (stuck-dot fix).
  writeThread("sweptcard", cardBlock("sweptcard", "2026-06-12T09:00:00Z", "SWEPT-Q"));

  // Seed the queue store so sweptcard's card id is handled.
  const queueStatePath = process.env["QUEUE_STATE_PATH"]!;
  fs.writeFileSync(
    queueStatePath,
    JSON.stringify({
      version: 1,
      deadlines: {},
      handled: ["sweptcard/2026-06-12T09:00:00Z/SWEPT-Q"],
    }),
    "utf8"
  );

  await page.goto("/");
  const sidebar = page.locator("nav");
  await expect(sidebar.getByRole("link", { name: /^readmsg/i })).toBeVisible();

  // read message, no card -> NEITHER dot.
  await expect(page.getByTestId("sidebar-dot-message-readmsg")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-dot-decision-readmsg")).toHaveCount(0);
  // unread message -> MESSAGE dot only (the behaviour missing for chatty agents).
  await expect(page.getByTestId("sidebar-dot-message-unreadmsg")).toBeVisible();
  await expect(page.getByTestId("sidebar-dot-decision-unreadmsg")).toHaveCount(0);
  // open un-swept card (read) -> DECISION dot only.
  await expect(page.getByTestId("sidebar-dot-decision-opencard")).toBeVisible();
  await expect(page.getByTestId("sidebar-dot-message-opencard")).toHaveCount(0);
  // swept card -> NO decision dot (was stuck-on before the fix).
  await expect(page.getByTestId("sidebar-dot-decision-sweptcard")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-dot-message-sweptcard")).toHaveCount(0);

  // The message dot uses the magenta token; the decision dot uses accent.
  const messageDot = page.getByTestId("sidebar-dot-message-unreadmsg");
  const messageColor = await messageDot.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  const decisionDot = page.getByTestId("sidebar-dot-decision-opencard");
  const decisionColor = await decisionDot.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  // #c2356b magenta vs #e8752a burnt-orange - distinct, and message is not orange.
  expect(messageColor).not.toBe(decisionColor);
  expect(messageColor).toBe("rgb(194, 53, 107)");
});

test("the active (open) thread clears its unread message dot instantly", async ({ page }) => {
  resetFixtureInbox();
  // unreadmsg has a fresh unread message from the agent.
  writeThread("unreadmsg", msg("unreadmsg", "2026-06-12T10:00:00Z", "sent", "ping"));

  // On the home page it shows the magenta dot.
  await page.goto("/");
  await expect(page.getByTestId("sidebar-dot-message-unreadmsg")).toBeVisible();

  // Open that thread - the dot clears immediately (no waiting for a poll),
  // because the active thread is treated as read in the shell loader.
  await page.goto("/threads/unreadmsg");
  await expect(page.getByTestId("sidebar-dot-message-unreadmsg")).toHaveCount(0);
});
