/**
 * threads-compose-subject.test.ts
 *
 * Behaviour of the threads.$agent `compose` action branch. Two suites:
 *
 * 1. Subject derivation. Regression for the compose subject-bleed bug: the
 *    reply subject was derived from inbox.readBlocks(agent, user) keyed on the
 *    ROUTE PARAM, but the reply is written to writeTarget = payload.targetAgent
 *    ?? agent. On the TASK-500 deliver-on-switch path (route open on thread A,
 *    pending batch targets thread B) these diverge, so the reply landed in B
 *    carrying A's subject. Fix: writeTarget is hoisted above the subject read
 *    and the blocks are read from writeTarget, so the subject always matches
 *    the thread the reply lands in.
 *
 * 2. TASK-475 open-card auto-resolve: a free-text reply into a thread whose
 *    most-recent decision card is still open resolves that card as its custom
 *    (option C) answer, instead of landing as a plain message and leaving the
 *    card awaiting a tap forever. Same harness, same action export - hence
 *    this file rather than a fresh one.
 *
 * Drives the route's `action` export directly (see agent-model.test.ts /
 * api-cron.test.ts) against a sandboxed INBOX_ROOT (see inbox-targeting.test.ts).
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import { action } from "../app/routes/threads.$agent";

// ---------------------------------------------------------------------------
// Fixtures: an agent-authored block per thread, each with a distinct subject.
// The block's `from` must differ from the instance user (alex) so the action's
// last-agent-block scan picks it up as the subject source.
// ---------------------------------------------------------------------------

function agentBlock(from: string, subject: string): string {
  return [
    `## 2026-06-09T10:00:00Z - from: ${from} - status: read - subject: ${subject}`,
    ``,
    `A message from ${from}.`,
    ``,
    `---`,
  ].join("\n");
}

/**
 * A decision-card block. `extraMeta` appends meta lines AFTER the options list,
 * which is exactly where the real writeback (setMetaLine) puts them - so
 * `answered: A` / `dismissed: <iso>` / `superseded: <iso>` fixtures here have
 * the same on-disk shape a live resolution produces.
 */
function decisionBlock(opts: {
  from: string;
  subject: string;
  decisionId: string;
  timestamp: string;
  extraMeta?: string[];
}): string {
  return [
    `## ${opts.timestamp} - from: ${opts.from} - status: sent - subject: ${opts.subject}`,
    `decision-id: ${opts.decisionId}`,
    `options:`,
    `  - key: A`,
    `    label: "Hold"`,
    `    detail: "Conservative."`,
    `  - key: B`,
    `    label: "Push"`,
    `    detail: "Aggressive."`,
    ...(opts.extraMeta ?? []),
    ``,
    `Body of ${opts.decisionId}.`,
    ``,
    `---`,
  ].join("\n");
}

/** An ACTION card block. Parses into block.actionCard, never block.card. */
function actionBlock(opts: {
  from: string;
  subject: string;
  actionId: string;
  timestamp: string;
}): string {
  return [
    `## ${opts.timestamp} - from: ${opts.from} - status: sent - subject: ${opts.subject}`,
    `action-id: ${opts.actionId}`,
    `priority: high`,
    ``,
    `Body of ${opts.actionId}.`,
    ``,
    `---`,
  ].join("\n");
}

function seedInbox(root: string, agent: string, user: string, content: string): void {
  const inboxDir = path.join(root, agent, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, `${user}.md`), content, "utf8");
}

function readInbox(root: string, agent: string, user: string): string {
  return fs.readFileSync(path.join(root, agent, "inbox", `${user}.md`), "utf8");
}

/** Build a compose POST at /threads/<agent> with the given form fields. */
function composeRequest(agent: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams({ intent: "compose", ...fields });
  return new Request(`http://localhost/threads/${agent}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/** Invoke the route action with a params.agent (the open thread's route param). */
function callAction(agent: string, fields: Record<string, string>) {
  const request = composeRequest(agent, fields);
  return action({ request, params: { agent }, context: {} } as Parameters<typeof action>[0]);
}

/**
 * Register the per-test sandbox lifecycle: a fresh INBOX_ROOT temp dir, the
 * default "alex" MC_USER, and tmux disabled so no subprocess is spawned.
 * Hands the fresh root back through `setRoot` so each suite keeps its own
 * plain `root` binding.
 */
function installInboxSandbox(setRoot: (root: string) => void): void {
  const saved: Record<string, string | undefined> = {};
  let current = "";

  beforeEach(() => {
    current = mkdtempSync();
    setRoot(current);
    saved["INBOX_ROOT"] = process.env["INBOX_ROOT"];
    saved["MC_USER"] = process.env["MC_USER"];
    saved["MC_TMUX_ENABLED"] = process.env["MC_TMUX_ENABLED"];
    process.env["INBOX_ROOT"] = current;
    delete process.env["MC_USER"]; // defaults to "alex"
    process.env["MC_TMUX_ENABLED"] = "0"; // no tmux subprocess spawns in the test
  });

  afterEach(() => {
    rmSync(current);
    for (const key of ["INBOX_ROOT", "MC_USER", "MC_TMUX_ENABLED"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });
}

// ---------------------------------------------------------------------------

describe("threads compose subject derivation (deliver-on-switch bleed)", () => {
  let root: string;
  installInboxSandbox((r) => {
    root = r;
  });

  it("(a) deliver-on-switch: reply into the TARGET thread carries the target's subject, not the route param's", async () => {
    seedInbox(root, "atlas", "alex", agentBlock("atlas", "atlas topic"));
    seedInbox(root, "scribe", "alex", agentBlock("scribe", "scribe topic"));

    // Route still open on atlas, but the pending batch targets scribe.
    const result = await callAction("atlas", {
      body: "the reply body",
      targetAgent: "scribe",
    });
    expect((result as { ok: boolean }).ok).toBe(true);

    // The reply landed in scribe's inbox with scribe's subject...
    const scribeFile = readInbox(root, "scribe", "alex");
    expect(scribeFile).toContain("subject: Re: scribe topic");
    expect(scribeFile).not.toContain("Re: atlas topic");
    expect(scribeFile).toContain("the reply body");

    // ...and atlas's thread was not written to.
    const atlasFile = readInbox(root, "atlas", "alex");
    expect(atlasFile).not.toContain("the reply body");
  });

  it("(b) same-thread path (no targetAgent): subject still derives from the open thread", async () => {
    seedInbox(root, "atlas", "alex", agentBlock("atlas", "atlas topic"));

    const result = await callAction("atlas", { body: "same-thread reply" });
    expect((result as { ok: boolean }).ok).toBe(true);

    const atlasFile = readInbox(root, "atlas", "alex");
    expect(atlasFile).toContain("subject: Re: atlas topic");
    expect(atlasFile).toContain("same-thread reply");
  });

  it("(c) empty target thread: subject falls back to bare 'Message'", async () => {
    // Route open on atlas (which HAS a prior subject), but the reply targets
    // scribe whose thread has no prior agent block -> no subject to Re:.
    seedInbox(root, "atlas", "alex", agentBlock("atlas", "atlas topic"));
    seedInbox(root, "scribe", "alex", ""); // empty target thread

    const result = await callAction("atlas", {
      body: "into an empty thread",
      targetAgent: "scribe",
    });
    expect((result as { ok: boolean }).ok).toBe(true);

    const scribeFile = readInbox(root, "scribe", "alex");
    expect(scribeFile).toContain("subject: Message");
    expect(scribeFile).not.toContain("Re: atlas topic");
    expect(scribeFile).toContain("into an empty thread");
  });
});

// ---------------------------------------------------------------------------
// TASK-475: free text into a thread with an open decision card resolves it
// ---------------------------------------------------------------------------

/** Count blocks in a raw inbox file (one "## " header line per block). */
function blockCount(file: string): number {
  return file.split("\n").filter((l) => l.startsWith("## ")).length;
}

/** Count lines that are EXACTLY `text` (a body line, not a meta line quoting it). */
function bodyLineCount(file: string, text: string): number {
  return file.split("\n").filter((l) => l === text).length;
}

// EXPLICIT SKIP (2026-07-31): TASK-475 auto-resolve was emergency-disabled
// 2026-07-29 after its unbounded-age scan silently overwrote
// long-abandoned decision cards with unrelated free text (the corruption
// the platform agent recovered 8 cards from). Alex's call after reviewing the
// tradeoff: auto-completing a card without an explicit reply is the wrong
// UX regardless of the age bug - the manual dismiss button already covers
// the "clear an accidental card" case. Not reverting the feature (SPEC/
// history preserved) - the kill switch stays on and these tests stay
// skipped rather than pinning a spec nobody plans to build.
describe.skip("threads compose auto-resolves an open decision card (TASK-475)", () => {
  let root: string;
  installInboxSandbox((r) => {
    root = r;
  });

  it("(a) open card present: the free text resolves it as the custom (option C) answer", async () => {
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "ad spend",
        decisionId: "TASK-475-q1",
        timestamp: "2026-06-09T14:30:00Z",
      }) + "\n",
    );

    const result = await callAction("scribe", { body: "hold it for now" });
    expect(result).toEqual({ ok: true, alreadyAnswered: false });

    const file = readInbox(root, "scribe", "alex");
    // The original card flipped to the custom-answer terminal state...
    expect(file).toContain("answered: C");
    expect(file).toContain(`custom-answer: "hold it for now"`);
    // ...and the free text landed as the card's reply block.
    expect(file).toContain("answer: C");
    expect(file).toContain("subject: Re: ad spend");
    expect(file).toContain("from: alex");
  });

  it("(b) the text is written ONCE: customAnswerCard's reply block is not doubled by writeReply", async () => {
    // Guards the specific failure mode of routing through a second seam: if the
    // compose branch called BOTH customAnswerCard and writeReply the body would
    // appear in two appended blocks.
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "ad spend",
        decisionId: "TASK-475-q1",
        timestamp: "2026-06-09T14:30:00Z",
      }) + "\n",
    );

    await callAction("scribe", { body: "hold it for now" });

    const file = readInbox(root, "scribe", "alex");
    expect(blockCount(file)).toBe(2); // the card + exactly one reply
    expect(bodyLineCount(file, "hold it for now")).toBe(1);
  });

  it("(c) no card in the thread: the pre-existing plain-reply path is unchanged", async () => {
    seedInbox(root, "atlas", "alex", agentBlock("atlas", "atlas topic"));

    const result = await callAction("atlas", { body: "just a message" });
    // Plain path keeps its original bare shape (no alreadyAnswered key).
    expect(result).toEqual({ ok: true });

    const file = readInbox(root, "atlas", "alex");
    expect(file).toContain("subject: Re: atlas topic");
    expect(file).toContain("just a message");
    expect(file).not.toContain("answer: C");
    expect(file).not.toContain("answered:");
    expect(blockCount(file)).toBe(2);
  });

  it("(d) two open cards: the MOST RECENT resolves and the earlier one stays open", async () => {
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "older ask",
        decisionId: "TASK-475-old",
        timestamp: "2026-06-09T10:00:00Z",
      }) +
        "\n" +
        decisionBlock({
          from: "scribe",
          subject: "newer ask",
          decisionId: "TASK-475-new",
          timestamp: "2026-06-09T14:00:00Z",
        }) +
        "\n",
    );

    await callAction("scribe", { body: "go with the second one" });

    const file = readInbox(root, "scribe", "alex");
    // Split at the newer card's decision-id so each card's meta is checked in
    // isolation: a file-wide toContain("answered: C") cannot tell them apart.
    const [oldSection, newSection] = file.split("decision-id: TASK-475-new");
    expect(oldSection).not.toContain("answered: C");
    expect(newSection).toContain("answered: C");
    expect(newSection).toContain(`custom-answer: "go with the second one"`);
    // Reply subject proves the newer card was the target.
    expect(file).toContain("subject: Re: newer ask");
    expect(file).not.toContain("subject: Re: older ask");
  });

  it("(e) an open card BELOW a later resolved card still resolves (most-recent OPEN, not last-card-must-be-open)", async () => {
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "still open",
        decisionId: "TASK-475-open",
        timestamp: "2026-06-09T10:00:00Z",
      }) +
        "\n" +
        decisionBlock({
          from: "scribe",
          subject: "already done",
          decisionId: "TASK-475-done",
          timestamp: "2026-06-09T14:00:00Z",
          extraMeta: ["answered: A"],
        }) +
        "\n",
    );

    await callAction("scribe", { body: "resolving the open one" });

    const file = readInbox(root, "scribe", "alex");
    const [openSection, doneSection] = file.split("decision-id: TASK-475-done");
    expect(openSection).toContain("answered: C");
    expect(openSection).toContain(`custom-answer: "resolving the open one"`);
    // The already-answered card keeps its original answer, untouched.
    expect(doneSection).toContain("answered: A");
    expect(doneSection).not.toContain("answered: C");
    expect(file).toContain("subject: Re: still open");
  });

  // isDecisionResolved treats answered / dismissed / superseded as terminal.
  // A terminal card is NOT open, so the reply must fall through to a plain
  // message rather than attempt to re-resolve it.
  const TERMINAL_CASES: Array<{ label: string; meta: string[] }> = [
    { label: "answered", meta: ["answered: A"] },
    { label: "dismissed", meta: ["dismissed: 2026-06-09T12:00:00Z"] },
    { label: "superseded", meta: ["superseded: 2026-06-09T12:00:00Z"] },
  ];

  for (const { label, meta } of TERMINAL_CASES) {
    it(`(f-${label}) an ${label} card is not open: the reply falls through to a plain message`, async () => {
      seedInbox(
        root,
        "scribe",
        "alex",
        decisionBlock({
          from: "scribe",
          subject: "closed ask",
          decisionId: "TASK-475-closed",
          timestamp: "2026-06-09T10:00:00Z",
          extraMeta: meta,
        }) + "\n",
      );

      const result = await callAction("scribe", { body: "a later thought" });
      expect(result).toEqual({ ok: true });

      const file = readInbox(root, "scribe", "alex");
      expect(file).not.toContain("answered: C");
      expect(file).not.toContain("custom-answer:");
      expect(file).not.toContain("answer: C");
      // Plain reply, subject derived from the last agent block as before.
      expect(file).toContain("subject: Re: closed ask");
      expect(file).toContain("a later thought");
      expect(blockCount(file)).toBe(2);
    });
  }

  it("(g) an open ACTION card is not a decision card: the reply stays a plain message", async () => {
    // Action cards parse into block.actionCard, never block.card, so the scan
    // skips them by construction. Pins the "decision cards only" v1 boundary.
    seedInbox(
      root,
      "quill",
      "alex",
      actionBlock({
        from: "quill",
        subject: "review the spec",
        actionId: "TASK-475-review",
        timestamp: "2026-06-09T10:00:00Z",
      }) + "\n",
    );

    const result = await callAction("quill", { body: "will do later" });
    expect(result).toEqual({ ok: true });

    const file = readInbox(root, "quill", "alex");
    expect(file).not.toContain("answer: C");
    expect(file).not.toContain("answered:");
    expect(file).toContain("subject: Re: review the spec");
    expect(file).toContain("will do later");
  });

  it("(h) deliver-on-switch: the TARGET thread's open card resolves, the route thread's is untouched", async () => {
    // The auto-resolve must key off writeTarget, not params.agent - the same
    // divergence that caused the subject-bleed bug this file's first suite
    // covers, now with a destructive write on the line.
    seedInbox(
      root,
      "atlas",
      "alex",
      decisionBlock({
        from: "atlas",
        subject: "atlas ask",
        decisionId: "TASK-475-atlas",
        timestamp: "2026-06-09T10:00:00Z",
      }) + "\n",
    );
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "scribe ask",
        decisionId: "TASK-475-scribe",
        timestamp: "2026-06-09T10:00:00Z",
      }) + "\n",
    );

    await callAction("atlas", {
      body: "answering scribe",
      targetAgent: "scribe",
    });

    const scribeFile = readInbox(root, "scribe", "alex");
    expect(scribeFile).toContain("answered: C");
    expect(scribeFile).toContain(`custom-answer: "answering scribe"`);

    const atlasFile = readInbox(root, "atlas", "alex");
    expect(atlasFile).not.toContain("answered: C");
    expect(atlasFile).not.toContain("answering scribe");
  });

  it("(i) a dictated reply still resolves the card and carries its text", async () => {
    // KNOWN GAP (SPEC point 5): customAnswerCard's reply block does not carry
    // the `dictated: true` provenance line the plain path writes. Out of scope
    // for v1 (it needs a new param threaded through applyCustomAnswer), so this
    // test deliberately asserts NOTHING about that line in either direction -
    // it guards only that dictation does not break the new path, and leaves a
    // future fix free to add the line without fighting a test.
    seedInbox(
      root,
      "scribe",
      "alex",
      decisionBlock({
        from: "scribe",
        subject: "ad spend",
        decisionId: "TASK-475-q1",
        timestamp: "2026-06-09T14:30:00Z",
      }) + "\n",
    );

    const result = await callAction("scribe", {
      body: "spoken answer",
      dictated: "1",
    });
    expect(result).toEqual({ ok: true, alreadyAnswered: false });

    const file = readInbox(root, "scribe", "alex");
    expect(file).toContain("answered: C");
    expect(file).toContain(`custom-answer: "spoken answer"`);
    expect(bodyLineCount(file, "spoken answer")).toBe(1);
  });
});
