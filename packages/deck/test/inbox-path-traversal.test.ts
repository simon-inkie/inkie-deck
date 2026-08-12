/**
 * inbox-path-traversal.test.ts
 *
 * Sink-guard tests for FileInboxRepository.agentInboxDir (task #77).
 *
 * The private agentInboxDir is the single read-side sink: every read method
 * (readBlocks, readBlocksWindow, markRead, answerCard, ...) routes through it.
 * A traversal agentName ("../../tmp/evil") passed from an unvalidated route
 * param used to escape the inbox root on reads. The guard adds two checks
 * before path.join: an AGENT_NAME_RE shape check (parity with the write-path
 * guard, independent of any env config) and the optional allowlist check.
 *
 * Sandbox + env save/restore pattern mirrors inbox-targeting.test.ts and
 * safe-fs.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileInboxRepository } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const FIXTURE_CONTENT = [
  `## 2026-06-09T10:00:00Z - from: scribe - status: read - subject: hello`,
  ``,
  `A plain message.`,
  ``,
  `---`,
  ``,
].join("\n");

function seedInbox(
  sandboxRoot: string,
  agentName: string,
  participantName: string,
  content: string,
): void {
  const inboxDir = path.join(sandboxRoot, agentName, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${participantName}.md`),
    content,
    "utf8",
  );
}

describe("agentInboxDir sink guard (task #77 path traversal)", () => {
  let sandbox: string;
  let savedInboxRoot: string | undefined;
  let savedAllowlist: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    savedAllowlist = process.env["MC_INBOX_AGENT_ALLOWLIST"];
    process.env["INBOX_ROOT"] = sandbox;
    // Default case: allowlist unset (matches .env.example) so the shape check
    // is what does the work in cases 1, 2 and 4.
    delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
    seedInbox(sandbox, "quill", "alex", FIXTURE_CONTENT);
  });

  afterAll(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
    if (savedAllowlist === undefined) {
      delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
    } else {
      process.env["MC_INBOX_AGENT_ALLOWLIST"] = savedAllowlist;
    }
  });

  // Cases 3 and 4 mutate the allowlist var; reset it to unset after each so no
  // case leaks state into the next (or into other test files).
  afterEach(() => {
    delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
  });

  // Case 1: traversal payload rejected before any fs access.
  it("readBlocks with a traversal agentName throws", async () => {
    const repo = new FileInboxRepository(sandbox);

    await expect(
      repo.readBlocks("../../tmp/evil", "alex"),
    ).rejects.toThrow(/agent-name shape|FND-04/);
  });

  // Case 2: a valid, shape-matching agent still reads normally (regression).
  it("readBlocks on a seeded valid agent still works", async () => {
    const repo = new FileInboxRepository(sandbox);
    const blocks = await repo.readBlocks("quill", "alex");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header.from).toBe("scribe");
  });

  // Case 3: allowlist layered on top - valid shape but off the list is
  // rejected with the allowlist-specific message, not the shape message.
  it("allowlist set: on-list agent reads, off-list valid-shape agent throws the allowlist error", async () => {
    process.env["MC_INBOX_AGENT_ALLOWLIST"] = "quill";
    const repo = new FileInboxRepository(sandbox);

    const blocks = await repo.readBlocks("quill", "alex");
    expect(blocks).toHaveLength(1);

    // "scribe" is a valid shape, just not on the list: allowlist error, not
    // the shape error.
    await expect(repo.readBlocks("scribe", "alex")).rejects.toThrow(
      /MC_INBOX_AGENT_ALLOWLIST/,
    );
    await expect(
      repo.readBlocks("scribe", "alex"),
    ).rejects.not.toThrow(/agent-name shape/);
  });

  // Case 4: allowlist unset (default) - the shape check STILL rejects the
  // traversal payload, proving it does not depend on allowlist config.
  it("allowlist unset: traversal payload still throws (shape check is independent)", async () => {
    expect(process.env["MC_INBOX_AGENT_ALLOWLIST"]).toBeUndefined();
    const repo = new FileInboxRepository(sandbox);
    await expect(
      repo.readBlocks("../../tmp/evil", "alex"),
    ).rejects.toThrow(/agent-name shape|FND-04/);
  });
});
