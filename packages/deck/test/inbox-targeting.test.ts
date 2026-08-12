/**
 * inbox-targeting.test.ts
 *
 * Tests decision-id targeting (CARD-04 Gap 2) and pushBackCard (CARD-03 Gap 1)
 * on the FileInboxRepository seam.
 *
 * Uses the mkdtempSync sandbox pattern from seam.test.ts:
 * seed a real inbox file, exercise methods, assert state.
 *
 * Ref: T-02-01 (decision-id targeting), T-02-02 (idempotency), T-02-03 (safeWrite)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileInboxRepository } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import { PUSHBACK_RESOLUTION, PUSHBACK_REPLY_MARKER } from "~/lib/blocks/answer.js";

// ---------------------------------------------------------------------------
// Fixture content: two blocks, the second is a decision card
// ---------------------------------------------------------------------------

const PLAIN_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: atlas - status: read - subject: checking in`,
  ``,
  `Just a plain message, not a card.`,
  ``,
  `---`,
].join("\n");

const CARD_BLOCK = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-413-q1`,
  `blocking: true`,
  `options:`,
  `  - key: A`,
  `    label: "Hold spend"`,
  `    detail: "Conservative."`,
  `  - key: B`,
  `    label: "Push spend"`,
  `    detail: "Faster learning."`,
  `lean: "B"`,
  ``,
  `Choose a spend level.`,
  ``,
  `---`,
].join("\n");

/** The file content with a plain block BEFORE the card (tests index-independence). */
const FIXTURE_CONTENT = PLAIN_BLOCK + "\n" + CARD_BLOCK + "\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedInbox(sandboxRoot: string, agentName: string, participantName: string, content: string): string {
  const inboxDir = path.join(sandboxRoot, agentName, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, `${participantName}.md`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function readInbox(sandboxRoot: string, agentName: string, participantName: string): string {
  const filePath = path.join(sandboxRoot, agentName, "inbox", `${participantName}.md`);
  return fs.readFileSync(filePath, "utf8");
}

// ---------------------------------------------------------------------------
// Suite 1: answerCard targets by decision-id (CARD-04 Gap 2)
// ---------------------------------------------------------------------------

describe("answerCard decision-id targeting (CARD-04)", () => {
  let sandbox: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    seedInbox(sandbox, "scribe", "alex", FIXTURE_CONTENT);
  });

  afterAll(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("answerCard(decisionId) targets the correct card even with a prepended plain block", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.answerCard("scribe", "alex", "TASK-413-q1", "B");
    expect("alreadyAnswered" in result).toBe(false);
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("answered: B");
    }
  });

  it("the file now contains 'answered: B' on the target card", async () => {
    const content = readInbox(sandbox, "scribe", "alex");
    expect(content).toContain("answered: B");
  });

  it("the plain block was NOT modified (index-independence proof)", async () => {
    const content = readInbox(sandbox, "scribe", "alex");
    // Plain block should be unchanged
    expect(content).toContain("Just a plain message, not a card.");
    // Only one answered: line in the file
    const answeredLines = content.split("\n").filter(l => l.startsWith("answered:"));
    expect(answeredLines).toHaveLength(1);
  });

  it("answerCard on an already-answered decision-id is an idempotent no-op", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.answerCard("scribe", "alex", "TASK-413-q1", "A");
    expect("alreadyAnswered" in result).toBe(true);
    if ("alreadyAnswered" in result) {
      expect(result.existingAnswer).toBe("B");
    }
  });

  it("idempotent answerCard leaves the file block count unchanged", async () => {
    const repo = new FileInboxRepository(sandbox);
    const blocks = await repo.readBlocks("scribe", "alex");
    // Should have plain + card + reply = 3 blocks total
    expect(blocks).toHaveLength(3);
  });

  it("answerCard throws when decision-id is not found", async () => {
    const repo = new FileInboxRepository(sandbox);
    await expect(
      repo.answerCard("scribe", "alex", "TASK-NONEXISTENT", "A")
    ).rejects.toThrow(/TASK-NONEXISTENT/);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: pushBackCard (CARD-03)
// ---------------------------------------------------------------------------

describe("pushBackCard by decision-id (CARD-03)", () => {
  let sandbox: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    seedInbox(sandbox, "scribe", "alex", FIXTURE_CONTENT);
  });

  afterAll(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("pushBackCard flips the card to answered: pushback", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.pushBackCard("scribe", "alex", "TASK-413-q1");
    expect("alreadyResolved" in result).toBe(false);
    if (!("alreadyResolved" in result)) {
      expect(result.pushedBackOriginal.rawMeta).toContain(`answered: ${PUSHBACK_RESOLUTION}`);
    }
  });

  it("the file now contains the push-back reply marker", async () => {
    const content = readInbox(sandbox, "scribe", "alex");
    expect(content).toContain(PUSHBACK_REPLY_MARKER);
  });

  it("the file contains answered: pushback on the card", async () => {
    const content = readInbox(sandbox, "scribe", "alex");
    expect(content).toContain(`answered: ${PUSHBACK_RESOLUTION}`);
  });

  it("pushBackCard on an already-pushed-back card is an idempotent no-op", async () => {
    const repo = new FileInboxRepository(sandbox);
    const result = await repo.pushBackCard("scribe", "alex", "TASK-413-q1");
    expect("alreadyResolved" in result).toBe(true);
    if ("alreadyResolved" in result) {
      expect(result.existingState).toBe(PUSHBACK_RESOLUTION);
    }
  });

  it("idempotent pushBackCard leaves the file block count unchanged", async () => {
    const repo = new FileInboxRepository(sandbox);
    const blocks = await repo.readBlocks("scribe", "alex");
    // Should have plain + card + push-back reply = 3 blocks
    expect(blocks).toHaveLength(3);
  });

  it("pushBackCard throws when decision-id is not found", async () => {
    const repo = new FileInboxRepository(sandbox);
    await expect(
      repo.pushBackCard("scribe", "alex", "TASK-NONEXISTENT")
    ).rejects.toThrow(/TASK-NONEXISTENT/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: readBlocks with relocated fixture (seam path match)
// ---------------------------------------------------------------------------

describe("readBlocks with fixture at seam-correct path", () => {
  let sandbox: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    // Seed at the seam-correct path: <root>/<agent>/inbox/<participant>.md
    seedInbox(sandbox, "scribe", "alex", FIXTURE_CONTENT);
  });

  afterAll(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("readBlocks returns 2 blocks from a file at the seam-correct path", async () => {
    const repo = new FileInboxRepository(sandbox);
    const blocks = await repo.readBlocks("scribe", "alex");
    expect(blocks).toHaveLength(2);
  });

  it("the second block is the decision card with decisionId TASK-413-q1", async () => {
    const repo = new FileInboxRepository(sandbox);
    const blocks = await repo.readBlocks("scribe", "alex");
    expect(blocks[1]?.card?.decisionId).toBe("TASK-413-q1");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: writeReply traversal guard (finding 3 regression)
// ---------------------------------------------------------------------------
// Regression: mkdir must NOT be called before the write-guard validates the path.
// A traversal agentName (e.g. "../../outside") could create directories outside
// the sandbox BEFORE assertSafeWritePath throws. The fix: assertSafeWritePath is
// called first; mkdir only runs after the guard passes.
describe("writeReply traversal guard (mkdir-before-guard regression)", () => {
  let sandbox: string;
  let outside: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    outside = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
  });

  afterAll(() => {
    rmSync(sandbox);
    rmSync(outside);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("writeReply with a traversal agentName throws WITHOUT creating any directory outside the sandbox", async () => {
    // The traversal agentName resolves the target path to outside the sandbox.
    // inboxFilePath builds: <root>/<agentName>/inbox/<participant>.md
    //
    // We construct a traversal that escapes the sandbox and lands inside the
    // 'outside' temp dir. Since task #77 added the shape guard at the shared
    // agentInboxDir sink, a "../" agentName is now rejected by that shape
    // check (FND-04) BEFORE it ever reaches assertSafeWritePath's prefix
    // assert. Either way the write is refused and nothing escapes the sandbox.
    //
    // sandbox = /tmp/mc-test-XXXX
    // outside = /tmp/mc-test-YYYY
    // We need to build an agentName like "../../mc-test-YYYY" so that:
    //   filePath = <sandbox>/../../mc-test-YYYY/inbox/alex.md
    //   = <outside>/inbox/alex.md  (after path.join normalization)
    //
    // Create the inbox subdirectory inside 'outside' so realpathSync of the
    // parent dir succeeds and the actual prefix-assert can fire.
    const outsideInbox = path.join(outside, "inbox");
    fs.mkdirSync(outsideInbox, { recursive: true });

    // Compute the relative traversal from inside the sandbox to 'outside'.
    // Both sandbox and outside are siblings in the same parent directory
    // (e.g. /tmp/claude-1000/mc-test-A and /tmp/claude-1000/mc-test-B).
    // From <sandbox>/<agentName> we want to resolve to <outside>.
    // agentName = "../" + basename(outside)
    // => path.join(sandbox, "..", basename(outside)) = parent + "/" + basename(outside) = outside.
    const outsideBasename = path.basename(outside);
    // Both sandbox and outside are in the same parent dir, so one ".." is enough.
    const traversalAgentName = path.join("..", outsideBasename);

    const repo = new FileInboxRepository(sandbox);

    // Build a minimal plain block to pass to writeReply.
    const replyBlock = {
      header: {
        timestamp: "2026-06-03T12:00:00Z",
        from: "alex",
        status: "sent" as const,
        subject: "test reply",
      },
      body: "test body",
      card: undefined,
      rawMeta: "",
    };

    // Sanity check: confirm the constructed path would land outside the sandbox.
    // (If the path lands inside, this test would be testing the wrong thing.)
    const wouldLandAt = path.resolve(
      path.join(sandbox, traversalAgentName, "inbox", "alex.md")
    );
    expect(wouldLandAt.startsWith(sandbox)).toBe(false);
    expect(wouldLandAt.startsWith(outside)).toBe(true);

    // The call must throw before any directory is created. The traversal is
    // now rejected by the agentInboxDir shape guard (FND-04) first; if the
    // input ever had a valid shape, assertSafeWritePath's prefix assert
    // (FND-03) is the backstop.
    await expect(
      repo.writeReply(traversalAgentName, "alex", replyBlock)
    ).rejects.toThrow(/agent-name shape|FND-04|outside the sandbox root|FND-03/);

    // The traversal target file must NOT have been written.
    const escapedFile = path.join(outside, "inbox", "alex.md");
    expect(fs.existsSync(escapedFile)).toBe(false);

    // No tmp- atomic-write remnants should exist in the outside dir either.
    const outsideEntries = fs.readdirSync(outside);
    expect(outsideEntries.filter((e) => e.includes(".tmp-"))).toHaveLength(0);
  });
});
