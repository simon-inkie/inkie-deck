/**
 * inbox-cards-thread-c.test.ts
 *
 * Seam-level integration tests for the Thread C write paths on
 * FileInboxRepository: dismissDecisionCard, supersedeActionCard,
 * supersedeDecisionCard. Exercises the real file read -> apply -> write ->
 * reply-append cycle in a mkdtempSync sandbox (same pattern as
 * inbox-targeting.test.ts), then re-reads to confirm the on-disk state and the
 * appended reply block round-trip.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileInboxRepository } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const DECISION_BLOCK = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-500-q1`,
  `options:`,
  `  - key: A`,
  `    label: "Hold"`,
  `    detail: "Conservative."`,
  `  - key: B`,
  `    label: "Push"`,
  `    detail: "Aggressive."`,
  ``,
  `Choose a spend level.`,
  ``,
  `---`,
].join("\n");

const ACTION_BLOCK = [
  `## 2026-06-09T15:00:00Z - from: quill - status: sent - subject: review the spec`,
  `action-id: TASK-500-review`,
  `priority: high`,
  ``,
  `Please review before merge.`,
  ``,
  `---`,
].join("\n");

const FIXTURE = DECISION_BLOCK + "\n" + ACTION_BLOCK + "\n";

function seedInbox(root: string, agent: string, participant: string, content: string): void {
  const dir = path.join(root, agent, "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${participant}.md`), content, "utf8");
}

function readInbox(root: string, agent: string, participant: string): string {
  return fs.readFileSync(path.join(root, agent, "inbox", `${participant}.md`), "utf8");
}

describe("Thread C seam write paths", () => {
  let sandbox: string;
  let saved: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync();
    saved = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    seedInbox(sandbox, "scribe", "alex", FIXTURE);
  });

  afterEach(() => {
    rmSync(sandbox);
    if (saved === undefined) delete process.env["INBOX_ROOT"];
    else process.env["INBOX_ROOT"] = saved;
  });

  it("dismissDecisionCard writes dismissed: + a dismissed-reply, and re-read shows the state", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.dismissDecisionCard("scribe", "alex", "TASK-500-q1", "no longer relevant");
    expect("dismissedBlock" in result).toBe(true);

    const blocks = await repo.readBlocks("scribe", "alex");
    const decision = blocks.find((b) => b.card?.decisionId === "TASK-500-q1");
    expect(decision?.card?.dismissed).toBeDefined();
    expect(decision?.card?.dismissReason).toBe("no longer relevant");
    // A reply block was appended (from alex, dismissed-reply marker).
    const reply = blocks[blocks.length - 1];
    expect(reply?.rawMeta).toContain("dismissed-reply: true");
    expect(reply?.header.from).toBe("alex");
  });

  it("dismissDecisionCard is idempotent on a second call (no duplicate reply)", async () => {
    const repo = new FileInboxRepository(sandbox);
    await repo.dismissDecisionCard("scribe", "alex", "TASK-500-q1");
    const countAfterFirst = (await repo.readBlocks("scribe", "alex")).length;
    const second = await repo.dismissDecisionCard("scribe", "alex", "TASK-500-q1");
    expect("alreadyDismissed" in second).toBe(true);
    const countAfterSecond = (await repo.readBlocks("scribe", "alex")).length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("supersedeActionCard writes superseded: + a superseded-reply", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.supersedeActionCard("scribe", "alex", "TASK-500-review", "replaced by TASK-501");
    expect("supersededBlock" in result).toBe(true);

    const blocks = await repo.readBlocks("scribe", "alex");
    const action = blocks.find((b) => b.actionCard?.actionId === "TASK-500-review");
    expect(action?.actionCard?.superseded).toBeDefined();
    expect(action?.actionCard?.supersedeNote).toBe("replaced by TASK-501");
    expect(readInbox(sandbox, "scribe", "alex")).toContain("superseded-reply: true");
  });

  it("supersedeDecisionCard writes superseded: on the decision", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.supersedeDecisionCard("scribe", "alex", "TASK-500-q1", "replaced");
    expect("supersededBlock" in result).toBe(true);

    const blocks = await repo.readBlocks("scribe", "alex");
    const decision = blocks.find((b) => b.card?.decisionId === "TASK-500-q1");
    expect(decision?.card?.superseded).toBeDefined();
    expect(decision?.card?.supersedeNote).toBe("replaced");
  });

  it("mutual exclusion holds through the seam: a superseded action cannot then be dismissed", async () => {
    const repo = new FileInboxRepository(sandbox);
    await repo.supersedeActionCard("scribe", "alex", "TASK-500-review");
    const dismiss = await repo.markActionDismissed("scribe", "alex", "TASK-500-review", "too late");
    expect("alreadySuperseded" in dismiss).toBe(true);
    // No dismiss reply leaked in.
    expect(readInbox(sandbox, "scribe", "alex")).not.toContain("dismissed-reply: true");
  });

  it("mutual exclusion holds through the seam: a dismissed decision cannot then be answered", async () => {
    const repo = new FileInboxRepository(sandbox);
    await repo.dismissDecisionCard("scribe", "alex", "TASK-500-q1");
    const answer = await repo.answerCard("scribe", "alex", "TASK-500-q1", "B");
    expect("alreadyDismissed" in answer).toBe(true);
    const decision = (await repo.readBlocks("scribe", "alex")).find(
      (b) => b.card?.decisionId === "TASK-500-q1"
    );
    expect(decision?.card?.answered).toBeUndefined();
  });
});
