/**
 * read-receipt.test.ts - the SYSTEM.md sent->read flip on the operator's render.
 *
 * Scope fence: only the OTHER side's blocks flip when the
 * thread participant renders. No symmetric flip - alex's own blocks are
 * never touched by markRead(agent, "alex"). "working" and already-"read"
 * statuses are also untouched. Idempotent: nothing to flip = no write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileInboxRepository } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const THREAD = `## 2026-06-07T18:00:00Z - from: quill - status: sent - subject: e2e probe one

First inbound message.

---
## 2026-06-07T18:05:00Z - from: alex - status: sent - subject: re: e2e probe one

The user's own sent block - must never flip here.

---
## 2026-06-07T18:10:00Z - from: quill - status: read - subject: already read

Already read - untouched.

---
## 2026-06-07T18:15:00Z - from: quill - status: working - subject: in progress
ticket: TASK-999

Working state (TASK-444) - untouched.

---
## 2026-06-07T18:20:00Z - from: quill - status: sent - subject: decision card
decision-id: TEST-1
blocking: true
options:
  - key: A
    label: "Option A"
lean: "A"

Card body - rawMeta must survive the flip byte-for-byte.

---
`;

describe("markRead - the sent->read receipt flip", () => {
  let sandbox: string;
  let repo: FileInboxRepository;
  let savedInboxRoot: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync();
    fs.mkdirSync(path.join(sandbox, "quill", "inbox"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "quill", "inbox", "alex.md"), THREAD, "utf8");
    // The write guard resolves the root from env - point it at the
    // sandbox for the duration of each test.
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    repo = new FileInboxRepository(sandbox);
  });

  afterEach(() => {
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
    rmSync(sandbox);
  });

  function rawThread(): string {
    return fs.readFileSync(path.join(sandbox, "quill", "inbox", "alex.md"), "utf8");
  }

  it("flips the other side's sent blocks to read ON DISK and reports the count", async () => {
    const flipped = await repo.markRead("quill", "alex");
    expect(flipped).toBe(2); // probe one + decision card

    const raw = rawThread();
    expect(raw).toContain("from: quill - status: read - subject: e2e probe one");
    expect(raw).toContain("from: quill - status: read - subject: decision card");
    expect(raw).not.toContain("from: quill - status: sent");
  });

  it("never flips the participant's own blocks (no symmetric flip)", async () => {
    await repo.markRead("quill", "alex");
    expect(rawThread()).toContain(
      "from: alex - status: sent - subject: re: e2e probe one"
    );
  });

  it("leaves working and already-read statuses untouched", async () => {
    await repo.markRead("quill", "alex");
    const raw = rawThread();
    expect(raw).toContain("status: working - subject: in progress");
    expect(raw).toContain("status: read - subject: already read");
  });

  it("preserves rawMeta (card options) through the flip", async () => {
    await repo.markRead("quill", "alex");
    const raw = rawThread();
    expect(raw).toContain("decision-id: TEST-1");
    expect(raw).toContain('label: "Option A"');
    expect(raw).toContain('lean: "A"');
    expect(raw).toContain("ticket: TASK-999");
  });

  it("is idempotent: second call flips nothing and does not rewrite the file", async () => {
    await repo.markRead("quill", "alex");
    const afterFirst = rawThread();
    const statBefore = fs.statSync(path.join(sandbox, "quill", "inbox", "alex.md"));

    const flipped = await repo.markRead("quill", "alex");
    expect(flipped).toBe(0);
    expect(rawThread()).toBe(afterFirst);
    const statAfter = fs.statSync(path.join(sandbox, "quill", "inbox", "alex.md"));
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs); // zero flips = zero writes
  });

  it("returns 0 for a missing thread file (no receipt to give)", async () => {
    expect(await repo.markRead("briar", "alex")).toBe(0);
    expect(fs.existsSync(path.join(sandbox, "briar"))).toBe(false);
  });

  it("re-read through the repository shows the flipped state", async () => {
    await repo.markRead("quill", "alex");
    const blocks = await repo.readBlocks("quill", "alex");
    const ioStatuses = blocks
      .filter((b) => b.header.from === "quill")
      .map((b) => b.header.status);
    expect(ioStatuses).toEqual(["read", "read", "working", "read"]);
  });

  it("propagates an allowlist refusal (the loader catches it; render survives)", async () => {
    const saved = process.env["MC_INBOX_AGENT_ALLOWLIST"];
    try {
      process.env["MC_INBOX_AGENT_ALLOWLIST"] = "scribe";
      await expect(repo.markRead("quill", "alex")).rejects.toThrow(
        /not in MC_INBOX_AGENT_ALLOWLIST/
      );
      // And the file is untouched.
      expect(rawThread()).toBe(THREAD);
    } finally {
      if (saved === undefined) {
        delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
      } else {
        process.env["MC_INBOX_AGENT_ALLOWLIST"] = saved;
      }
    }
  });
});
