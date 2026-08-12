/**
 * inbox-window.test.ts - readBlocksWindow, the thread view's chunked
 * lazy-load read (TASK-469).
 *
 * Proves:
 *   1. Default window = the last N blocks with the correct startIndex cursor
 *      and totalCount.
 *   2. before-cursor chunking returns the PREVIOUS chunk, including the
 *      short head chunk at the top of the thread.
 *   3. anchorId (deep-link focus) extends the window back to the target
 *      card through to the thread end; unknown ids fall back to the tail.
 *   4. The read is participant-parameterised (TASK-462 contract): the SAME
 *      call shape reads robin.md when the participant is robin - no
 *      hardcoded "alex" anywhere in the window path.
 *   5. Missing file -> empty window (totalCount 0), not a throw.
 *
 * The full readBlocks stays the contract for whole-thread consumers
 * (home/shell Needs-You derivation) - untouched by TASK-469.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileInboxRepository, DEFAULT_WINDOW_LIMIT } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

/**
 * Build a synthetic thread of `count` blocks. Block i has subject "msg i".
 * Block index `cardAt` (if given) is a decision card with decision-id
 * "WIN-TEST-card"; block index `actionAt` (if given) is an action card with
 * action-id "WIN-TEST-action".
 */
function buildThread(count: number, opts: { cardAt?: number; actionAt?: number } = {}): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const from = i % 2 === 0 ? "quill" : "alex";
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(10 + Math.floor(i / 60)).padStart(2, "0");
    out += `## 2026-06-10T${hour}:${minute}:00Z - from: ${from} - status: read - subject: msg ${i}\n`;
    if (i === opts.cardAt) {
      out += `decision-id: WIN-TEST-card\noptions:\n  - key: A\n    label: "Option A"\n    detail: "First option."\n  - key: B\n    label: "Option B"\n    detail: "Second option."\n`;
    }
    if (i === opts.actionAt) {
      out += `action-id: WIN-TEST-action\n`;
    }
    out += `\nBody of message ${i}.\n\n---\n`;
  }
  return out;
}

describe("readBlocksWindow (TASK-469)", () => {
  let sandbox: string;
  let repo: FileInboxRepository;
  let savedInboxRoot: string | undefined;

  function seed(agent: string, participant: string, content: string) {
    const dir = path.join(sandbox, agent, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${participant}.md`), content, "utf8");
  }

  beforeEach(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    repo = new FileInboxRepository(sandbox);
  });

  afterEach(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Default tail window
  // -------------------------------------------------------------------------

  it("returns the last N blocks with startIndex and totalCount", async () => {
    seed("quill", "alex", buildThread(100));
    const win = await repo.readBlocksWindow("quill", "alex", { limit: 30 });

    expect(win.totalCount).toBe(100);
    expect(win.startIndex).toBe(70);
    expect(win.blocks).toHaveLength(30);
    expect(win.blocks[0]!.header.subject).toBe("msg 70");
    expect(win.blocks[29]!.header.subject).toBe("msg 99");
  });

  it("returns the whole thread when it is shorter than the limit", async () => {
    seed("quill", "alex", buildThread(5));
    const win = await repo.readBlocksWindow("quill", "alex", { limit: 30 });

    expect(win.totalCount).toBe(5);
    expect(win.startIndex).toBe(0);
    expect(win.blocks).toHaveLength(5);
  });

  it("defaults the limit to DEFAULT_WINDOW_LIMIT", async () => {
    seed("quill", "alex", buildThread(80));
    const win = await repo.readBlocksWindow("quill", "alex");

    expect(win.blocks).toHaveLength(DEFAULT_WINDOW_LIMIT);
    expect(win.startIndex).toBe(80 - DEFAULT_WINDOW_LIMIT);
  });

  // -------------------------------------------------------------------------
  // 2. Load-older cursor (before)
  // -------------------------------------------------------------------------

  it("before-cursor returns the previous chunk ending just before the cursor", async () => {
    seed("quill", "alex", buildThread(100));
    // First page = [70, 100). Load older from its startIndex.
    const older = await repo.readBlocksWindow("quill", "alex", { before: 70, limit: 30 });

    expect(older.totalCount).toBe(100);
    expect(older.startIndex).toBe(40);
    expect(older.blocks).toHaveLength(30);
    expect(older.blocks[0]!.header.subject).toBe("msg 40");
    expect(older.blocks[29]!.header.subject).toBe("msg 69");
  });

  it("before-cursor clamps the short head chunk at the top of the thread", async () => {
    seed("quill", "alex", buildThread(100));
    const head = await repo.readBlocksWindow("quill", "alex", { before: 10, limit: 30 });

    expect(head.startIndex).toBe(0);
    expect(head.blocks).toHaveLength(10);
    expect(head.blocks[0]!.header.subject).toBe("msg 0");
    expect(head.blocks[9]!.header.subject).toBe("msg 9");
  });

  it("before: 0 returns an empty chunk (nothing older exists)", async () => {
    seed("quill", "alex", buildThread(50));
    const win = await repo.readBlocksWindow("quill", "alex", { before: 0, limit: 30 });

    expect(win.blocks).toHaveLength(0);
    expect(win.startIndex).toBe(0);
    expect(win.totalCount).toBe(50);
  });

  it("chunk pages tile the thread with no gap and no overlap", async () => {
    seed("quill", "alex", buildThread(75));
    const page1 = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
    const page2 = await repo.readBlocksWindow("quill", "alex", { before: page1.startIndex, limit: 30 });
    const page3 = await repo.readBlocksWindow("quill", "alex", { before: page2.startIndex, limit: 30 });

    const subjects = [...page3.blocks, ...page2.blocks, ...page1.blocks].map(
      (b) => b.header.subject
    );
    expect(subjects).toHaveLength(75);
    expect(subjects).toEqual(
      Array.from({ length: 75 }, (_, i) => `msg ${i}`)
    );
  });

  // -------------------------------------------------------------------------
  // 3. Deep-link anchor (anchorId)
  // -------------------------------------------------------------------------

  it("anchorId extends the window back to an out-of-window decision card", async () => {
    seed("quill", "alex", buildThread(100, { cardAt: 12 }));
    const win = await repo.readBlocksWindow("quill", "alex", {
      limit: 30,
      anchorId: "WIN-TEST-card",
    });

    // Window runs from the card through to the thread end.
    expect(win.startIndex).toBe(12);
    expect(win.blocks).toHaveLength(88);
    expect(win.blocks[0]!.card?.decisionId).toBe("WIN-TEST-card");
    expect(win.blocks[win.blocks.length - 1]!.header.subject).toBe("msg 99");
    expect(win.totalCount).toBe(100);
  });

  it("anchorId matches action cards too", async () => {
    seed("quill", "alex", buildThread(100, { actionAt: 5 }));
    const win = await repo.readBlocksWindow("quill", "alex", {
      limit: 30,
      anchorId: "WIN-TEST-action",
    });

    expect(win.startIndex).toBe(5);
    expect(win.blocks[0]!.actionCard?.actionId).toBe("WIN-TEST-action");
  });

  it("anchorId already inside the tail window leaves the window unchanged", async () => {
    seed("quill", "alex", buildThread(100, { cardAt: 95 }));
    const win = await repo.readBlocksWindow("quill", "alex", {
      limit: 30,
      anchorId: "WIN-TEST-card",
    });

    expect(win.startIndex).toBe(70);
    expect(win.blocks).toHaveLength(30);
  });

  it("an unknown anchorId falls back to the plain tail window", async () => {
    seed("quill", "alex", buildThread(100));
    const win = await repo.readBlocksWindow("quill", "alex", {
      limit: 30,
      anchorId: "NO-SUCH-CARD",
    });

    expect(win.startIndex).toBe(70);
    expect(win.blocks).toHaveLength(30);
  });

  // -------------------------------------------------------------------------
  // 4. Participant parameterisation (TASK-462 contract)
  // -------------------------------------------------------------------------

  it("reads the participant's file, not a hardcoded alex.md", async () => {
    seed("quill", "alex", buildThread(40));
    seed("quill", "robin", buildThread(7));

    const robinWin = await repo.readBlocksWindow("quill", "robin", { limit: 30 });
    expect(robinWin.totalCount).toBe(7);
    expect(robinWin.startIndex).toBe(0);
    expect(robinWin.blocks).toHaveLength(7);

    const alexWin = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
    expect(alexWin.totalCount).toBe(40);
    expect(alexWin.startIndex).toBe(10);
  });

  // -------------------------------------------------------------------------
  // 5. Missing file / degenerate input
  // -------------------------------------------------------------------------

  it("returns an empty window for a missing thread file", async () => {
    const win = await repo.readBlocksWindow("quill", "alex", { limit: 30 });

    expect(win.blocks).toHaveLength(0);
    expect(win.startIndex).toBe(0);
    expect(win.totalCount).toBe(0);
  });

  it("clamps a degenerate limit to at least one block", async () => {
    seed("quill", "alex", buildThread(10));
    const win = await repo.readBlocksWindow("quill", "alex", { limit: 0 });

    expect(win.blocks).toHaveLength(1);
    expect(win.startIndex).toBe(9);
  });
});
