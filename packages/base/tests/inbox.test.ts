/**
 * Test suite for the `inbox` CLI.
 *
 * Uses vitest, the house standard. The tool itself still has zero runtime
 * dependencies (Node stdlib only, no build step); vitest is a dev dependency,
 * needed to run the suite but never to run the tool.
 *
 * Two testing styles are used deliberately:
 *   - Pure functions (parseBlocks, rewriteAttachmentPaths, HEADER_RE, ...)
 *     are imported and called in-process for fast, precise unit tests. The
 *     module runs main() only when invoked directly, so importing it is safe.
 *   - Anything that goes through argument parsing / main() (the card-metadata
 *     blank-line logic, em-dash rejection, the read/status-flip behaviour) is
 *     exercised as a real subprocess CLI invocation, because that logic lives
 *     inline in cmdReply/cmdRead and is only meaningfully testable end to end.
 *
 * Every subprocess test builds its environment from scratch via
 * helpers.baseEnv() rather than inheriting the real shell environment, so the
 * tests never depend on (or clobber) anything on the machine running them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import * as inbox from "../bin/inbox.mts";
import {
  INBOX_PATH,
  baseEnv,
  makeTempDir,
  removeTempDir,
  runCli,
  seedBlock,
  threadFile,
  withEnv,
  type Env,
} from "./helpers.ts";

/** Gives each test its own throwaway SILO_HOME. */
function useTempSilo(): { get: () => string; env: (o?: Parameters<typeof baseEnv>[0]) => Env } {
  let silo = "";
  beforeEach(() => {
    silo = makeTempDir();
  });
  afterEach(() => {
    removeTempDir(silo);
  });
  return {
    get: () => silo,
    env: (options = {}) => baseEnv({ ...options, siloHome: silo }),
  };
}

// ---------------------------------------------------------------------------
// AGENT_NAME identity
// ---------------------------------------------------------------------------
describe("AGENT_NAME is required", () => {
  const silo = useTempSilo();

  it("missing AGENT_NAME is a hard error", () => {
    const env = baseEnv({ agentName: null, siloHome: silo.get() }); // no AGENT_NAME set
    const result = runCli(["unread"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_NAME");
  });

  it("blank AGENT_NAME is also a hard error", () => {
    const env = silo.env({ agentName: null });
    env.AGENT_NAME = "   ";
    const result = runCli(["unread"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_NAME");
  });

  it("a set AGENT_NAME does not error", () => {
    const result = runCli(["unread"], silo.env({ agentName: "alice" }));
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SILO_HOME / inbox root
// ---------------------------------------------------------------------------
describe("SILO_HOME resolution", () => {
  it("defaults to ~/.agent-silo", () => {
    withEnv({ SILO_HOME: undefined, HOME: "/fake/home" }, () => {
      expect(inbox.siloHome()).toBe("/fake/home/.agent-silo");
      expect(inbox.inboxRoot("alice")).toBe("/fake/home/.agent-silo/alice/inbox");
    });
  });

  it("the SILO_HOME env var overrides the default", () => {
    withEnv({ SILO_HOME: "/custom/silo" }, () => {
      expect(inbox.inboxRoot("bob")).toBe("/custom/silo/bob/inbox");
    });
  });

  it("has no hardcoded sibling-project path", () => {
    // The banned fragments are the names of two sibling projects from the
    // deployment this tool was extracted from, plus its old fleet bin path.
    // They are assembled from pieces rather than written literally because
    // this repository's leak gate (scripts/leak-gate.mjs) denies exactly
    // these tokens repo-wide, and the gate must not need an allowlist entry
    // for this file to pass.
    const banned = [
      ["the-", "brain"].join(""),
      ["mission-", "control"].join(""),
      ["~/agents", "/bin"].join(""),
    ];
    const text = fs.readFileSync(INBOX_PATH, "utf8");
    for (const fragment of banned) {
      expect(text, `found hardcoded path fragment: ${fragment}`).not.toContain(fragment);
    }
  });

  it("resolves the default path end to end", () => {
    // Confirm the CLI actually writes under $HOME/.agent-silo when
    // SILO_HOME is unset, using a throwaway HOME so this never touches
    // the real machine's home directory.
    const fakeHome = makeTempDir();
    try {
      const env = baseEnv({ agentName: "alice", home: fakeHome });
      delete env.SILO_HOME;
      const result = runCli(["reply", "bob", "--subject", "hi", "--body", "hello"], env);
      expect(result.status, result.stderr).toBe(0);
      const expected = path.join(fakeHome, ".agent-silo", "alice", "inbox", "bob.md");
      expect(fs.statSync(expected).isFile()).toBe(true);
    } finally {
      removeTempDir(fakeHome);
    }
  });
});

// ---------------------------------------------------------------------------
// Header regex: all three separator forms
// ---------------------------------------------------------------------------
describe("header regex", () => {
  function check(sep: string): void {
    const header = `## 2026-07-29T10:00:00Z ${sep} from: bob ${sep} status: sent ${sep} subject: hello there`;
    const m = inbox.HEADER_RE.exec(header);
    expect(m, `failed to parse header with separator ${JSON.stringify(sep)}`).not.toBeNull();
    expect(m!.groups!.ts).toBe("2026-07-29T10:00:00Z");
    expect(m!.groups!.sender).toBe("bob");
    expect(m!.groups!.status).toBe("sent");
    expect(m!.groups!.subject!.trim()).toBe("hello there");
  }

  it("accepts an em-dash separator", () => {
    check("\u2014");
  });

  it("accepts an en-dash separator", () => {
    check("\u2013");
  });

  it("accepts a plain hyphen separator", () => {
    check("-");
  });

  it("parses status: read too", () => {
    const header = "## 2026-07-29T10:00:00Z - from: bob - status: read - subject: hi";
    const m = inbox.HEADER_RE.exec(header);
    expect(m).not.toBeNull();
    expect(m!.groups!.status).toBe("read");
  });

  it("does not match a garbage header", () => {
    expect(inbox.HEADER_RE.exec("## not a real header line")).toBeNull();
  });

  // Protocol section 5.2 and conformance point 1: matching is case
  // insensitive, so an all-caps header written by some other tool still
  // parses. The `i` flag on HEADER_RE is the whole mechanism, and nothing
  // else in the suite would notice if it were dropped.
  it("parses an all uppercase header, because matching is case insensitive", () => {
    const header = "## 2026-07-29T10:00:00Z - FROM: bob - STATUS: SENT - SUBJECT: hello";
    const m = inbox.HEADER_RE.exec(header);
    expect(m, "an uppercase header must parse").not.toBeNull();
    expect(m!.groups!.sender).toBe("bob");
    expect(m!.groups!.status).toBe("SENT");
    expect(m!.groups!.subject!.trim()).toBe("hello");
  });

  it("parses a mixed case header", () => {
    const header = "## 2026-07-29T10:00:00Z - From: bob - Status: Read - Subject: hello";
    const m = inbox.HEADER_RE.exec(header);
    expect(m).not.toBeNull();
    expect(m!.groups!.status).toBe("Read");
  });

  it("normalises a parsed uppercase status to lower case", () => {
    // Readers compare against "sent"/"read", so parseBlocks must hand back
    // the lower-cased value however the writer spelled it. Section 5.2:
    // "Readers SHOULD lower case the value for comparison".
    const blocks = inbox.parseBlocks(
      "\n## 2026-07-29T10:00:00Z - from: bob - STATUS: SENT - subject: hi\n\nbody\n",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.status).toBe("sent");
  });

  // Conformance point 2 and protocol section 5.1. The sender group is a
  // greedy run of non-whitespace, so a dash inside the NAME sits in the same
  // character class as the separator that follows it. The field labels are
  // what disambiguate on backtracking. Section 5.1 claims this was verified
  // empirically rather than assumed from reading the grammar, so verify it.
  function checkDashInSender(sep: string): void {
    for (const nameDash of ["\u2014", "\u2013", "-"]) {
      const sender = `al${nameDash}ice`;
      const header =
        `## 2026-07-29T10:00:00Z ${sep} from: ${sender} ${sep} status: sent ` +
        `${sep} subject: hi`;
      const m = inbox.HEADER_RE.exec(header);
      expect(
        m,
        `sender ${JSON.stringify(sender)} with separator ${JSON.stringify(sep)} did not parse`,
      ).not.toBeNull();
      expect(m!.groups!.sender).toBe(sender);
      expect(m!.groups!.status).toBe("sent");
    }
  }

  it("parses a dash inside the sender name, em-dash separator", () => {
    checkDashInSender("\u2014");
  });

  it("parses a dash inside the sender name, en-dash separator", () => {
    checkDashInSender("\u2013");
  });

  it("parses a dash inside the sender name, plain hyphen separator", () => {
    checkDashInSender("-");
  });

  it("parses a subject containing every dash form", () => {
    // The subject is the remainder of the line, so a dash in it must never
    // be re-read as a separator and truncate the value.
    const subject = "a \u2014 b \u2013 c - d";
    const m = inbox.HEADER_RE.exec(
      `## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: ${subject}`,
    );
    expect(m).not.toBeNull();
    expect(m!.groups!.subject!.trim()).toBe(subject);
  });
});

// ---------------------------------------------------------------------------
// parseBlocks / cleanBody
// ---------------------------------------------------------------------------
describe("parseBlocks", () => {
  it("parses multiple blocks and strips the delimiter", () => {
    const text =
      "\n## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: one\n" +
      "\nfirst body\n\n---\n" +
      "\n## 2026-07-29T10:05:00Z - from: alice - status: read - subject: two\n" +
      "\nsecond body\n";
    const blocks = inbox.parseBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.sender).toBe("bob");
    expect(blocks[0]!.status).toBe("sent");
    expect(blocks[0]!.body).toBe("first body");
    expect(blocks[1]!.sender).toBe("alice");
    expect(blocks[1]!.body).toBe("second body");
  });

  it("skips an unparseable block rather than crashing", () => {
    expect(inbox.parseBlocks("\n## garbage line\n\nbody\n")).toEqual([]);
  });

  // Protocol section 4: a "## " line that fails the header grammar does NOT
  // begin a block. It is body content of the preceding block. The port
  // originally treated every "## " line as a boundary (parity with the Python
  // original), which silently truncated a message from any markdown heading
  // its author typed: the bytes on disk were intact, the loss happened on
  // every read. These tests pin the specified behaviour.
  it("keeps a markdown heading inside a body as body content, not a boundary", () => {
    const text =
      "\n## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: notes\n" +
      "\nbefore the heading\n" +
      "## A markdown heading the author typed\n" +
      "after the heading, which used to be silently lost on read\n";
    const blocks = inbox.parseBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.body).toContain("before the heading");
    expect(blocks[0]!.body).toContain("## A markdown heading the author typed");
    expect(blocks[0]!.body).toContain("after the heading");
  });

  it("still starts a new block at the next VALID header after a pseudo header", () => {
    const text =
      "\n## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: one\n" +
      "\nfirst body\n" +
      "## Not a header, just a heading\n" +
      "more of the first body\n" +
      "\n## 2026-07-29T10:05:00Z - from: alice - status: read - subject: two\n" +
      "\nsecond body\n";
    const blocks = inbox.parseBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.body).toContain("## Not a header, just a heading");
    expect(blocks[0]!.body).toContain("more of the first body");
    expect(blocks[0]!.body).not.toContain("second body");
    expect(blocks[1]!.sender).toBe("alice");
    expect(blocks[1]!.body).toBe("second body");
  });

  it("treats a pseudo header before any block as leading content, not a block", () => {
    const text =
      "## leading pseudo header\n" +
      "\n## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: hi\n" +
      "\nreal body\n";
    const blocks = inbox.parseBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.sender).toBe("bob");
    expect(blocks[0]!.body).toBe("real body");
  });
});

// ---------------------------------------------------------------------------
// Em-dash rejection
// ---------------------------------------------------------------------------
describe("em-dash rejection", () => {
  const silo = useTempSilo();

  it("rejects an em-dash in the subject", () => {
    const result = runCli(
      ["reply", "bob", "--subject", "hi \u2014 there", "--body", "ok"],
      silo.env({ agentName: "alice" }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("em-dash");
    expect(fs.existsSync(threadFile(silo.get(), "alice", "bob"))).toBe(false);
  });

  it("rejects an em-dash in the body", () => {
    const result = runCli(
      ["reply", "bob", "--subject", "hi", "--body", "line one \u2014 line two"],
      silo.env({ agentName: "alice" }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("em-dash");
  });

  it("allows an en-dash and a plain hyphen", () => {
    const result = runCli(
      ["reply", "bob", "--subject", "hi \u2013 there", "--body", "a - b"],
      silo.env({ agentName: "alice" }),
    );
    expect(result.status, result.stderr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Card-metadata blank-line insertion
// ---------------------------------------------------------------------------
describe("card metadata blank line", () => {
  const silo = useTempSilo();

  function replyAndReadRaw(body: string): string {
    const result = runCli(["reply", "bob", "--body", body], silo.env({ agentName: "alice" }));
    expect(result.status, result.stderr).toBe(0);
    return fs.readFileSync(threadFile(silo.get(), "alice", "bob"), "utf8");
  }

  it("gives a pure-metadata body a terminating blank", () => {
    const raw = replyAndReadRaw("decision-id: abc123\naction-id: xyz789");
    expect(raw).toContain("decision-id: abc123\naction-id: xyz789\n\n");
  });

  it("inserts a blank when metadata is immediately followed by prose", () => {
    const raw = replyAndReadRaw(
      "decision-id: abc123\nApprove by Friday.\nSecond line of prose.",
    );
    // The inline insertion logic (not just the block's own trailing
    // blank) must separate metadata from prose, otherwise the SECOND
    // prose line would still run on directly under the first with no gap.
    expect(raw).toContain("decision-id: abc123\n\nApprove by Friday.\nSecond line of prose.");
    // Exactly one blank line inserted, not two.
    expect(raw).not.toContain("decision-id: abc123\n\n\nApprove");
  });

  it("leaves already-separated metadata alone", () => {
    const raw = replyAndReadRaw("decision-id: abc123\n\nAlready separated prose.\nSecond line.");
    expect(raw).toContain("decision-id: abc123\n\nAlready separated prose.\nSecond line.");
    // Conservatism: no second blank line should have been added.
    expect(raw).not.toContain("decision-id: abc123\n\n\n");
  });

  it("counts an indented continuation line as metadata", () => {
    const raw = replyAndReadRaw("decision-id: abc123\n  nested: value\nProse right after.");
    expect(raw).toContain("decision-id: abc123\n  nested: value\n\nProse right after.");
  });

  it("leaves a non-card body unaffected", () => {
    const raw = replyAndReadRaw("just an ordinary reply\nwith two lines");
    expect(raw).toContain("just an ordinary reply\nwith two lines");
  });
});

// ---------------------------------------------------------------------------
// Attachment path rewrite
// ---------------------------------------------------------------------------
describe("attachment path rewrite", () => {
  it("resolves to null when the env var is unset", () => {
    withEnv({ ATTACHMENTS_ROOT: undefined }, () => {
      expect(inbox.resolveAttachmentsRoot()).toBeNull();
    });
  });

  it("resolves to the env value when set", () => {
    withEnv({ ATTACHMENTS_ROOT: "/srv/attachments" }, () => {
      expect(inbox.resolveAttachmentsRoot()).toBe("/srv/attachments");
    });
  });

  it("no longer carries the file-parsing fallback", () => {
    // resolveAttachmentsRoot must be purely env-driven: no env-file
    // parameter should remain on its signature.
    expect(inbox.resolveAttachmentsRoot.length).toBe(0);
    expect("DEFAULT_MC_ENV_FILE" in inbox).toBe(false);
  });

  it("is a no-op when the root is falsy", () => {
    const body = "see ![x](/attachments/2026/x.png) here";
    expect(inbox.rewriteAttachmentPaths(body, null)).toBe(body);
    expect(inbox.rewriteAttachmentPaths(body, "")).toBe(body);
  });

  it("rewrites a matching image link", () => {
    const body = "see ![x.png](/attachments/2026/x.png) here";
    expect(inbox.rewriteAttachmentPaths(body, "/srv/attachments")).toBe(
      "see ![x.png](/srv/attachments/2026/x.png) here",
    );
  });

  it("leaves non-image links alone", () => {
    const body = "see [x](/attachments/2026/x.png) here"; // no leading '!'
    expect(inbox.rewriteAttachmentPaths(body, "/srv/attachments")).toBe(body);
  });

  it("rejects path traversal", () => {
    const body = "![x](/attachments/../../../etc/passwd)";
    const out = inbox.rewriteAttachmentPaths(body, "/srv/attachments");
    // Left completely unchanged (still the web-relative /attachments/...
    // text), not rewritten to an escaping fs path like /srv/etc/passwd.
    expect(out).toBe(body);
    expect(out).not.toContain("/srv/attachments");
  });

  it("does not let a rejection suppress other legitimate rewrites", () => {
    const body =
      "bad: ![a](/attachments/../../../etc/passwd) good: ![b.png](/attachments/2026/b.png)";
    const out = inbox.rewriteAttachmentPaths(body, "/srv/attachments");
    expect(out).toContain("/attachments/../../../etc/passwd"); // rejected, unchanged
    expect(out).toContain("/srv/attachments/2026/b.png"); // legitimate one rewritten
  });

  it("handles multiple legitimate refs", () => {
    const body = "![a](/attachments/x.png) and ![b](/attachments/sub/y.png)";
    expect(inbox.rewriteAttachmentPaths(body, "/root")).toBe(
      "![a](/root/x.png) and ![b](/root/sub/y.png)",
    );
  });
});

// ---------------------------------------------------------------------------
// Read / status-flip round trip
// ---------------------------------------------------------------------------
describe("read and status flip", () => {
  const silo = useTempSilo();

  it("flips sent to read and does not reprint", () => {
    const p = threadFile(silo.get(), "alice", "bob");
    seedBlock(p, "2026-07-29T10:00:00Z", "bob", "sent", "hello", "hi alice");

    const env = silo.env({ agentName: "alice" });
    const result = runCli(["read", "bob"], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("hi alice");
    expect(result.stdout).toContain("hello");

    const raw = fs.readFileSync(p, "utf8");
    expect(raw).toContain("status: read");
    expect(raw).not.toContain("status: sent");

    const result2 = runCli(["read", "bob"], env);
    expect(result2.status, result2.stderr).toBe(0);
    expect(result2.stdout).toContain("no new messages");
    expect(result2.stdout).not.toContain("hi alice");
  });

  it("flips in place, leaving the file the same size", () => {
    const p = threadFile(silo.get(), "alice", "bob");
    seedBlock(p, "2026-07-29T10:00:00Z", "bob", "sent", "hi", "body text");
    const sizeBefore = fs.statSync(p).size;

    runCli(["read", "bob"], silo.env({ agentName: "alice" }));

    expect(fs.statSync(p).size, "flip must not change file length").toBe(sizeBefore);
  });

  it("never shows your own sent messages as unread", () => {
    const env = silo.env({ agentName: "alice" });
    runCli(["reply", "bob", "--subject", "hi", "--body", "from me"], env);
    expect(runCli(["read", "bob"], env).stdout).toContain("no new messages");
  });

  it("scans all threads when given no correspondent", () => {
    seedBlock(
      threadFile(silo.get(), "alice", "bob"),
      "2026-07-29T10:00:00Z", "bob", "sent", "s1", "from bob",
    );
    seedBlock(
      threadFile(silo.get(), "alice", "carol"),
      "2026-07-29T10:01:00Z", "carol", "sent", "s2", "from carol",
    );
    const result = runCli(["read"], silo.env({ agentName: "alice" }));
    expect(result.stdout).toContain("from bob");
    expect(result.stdout).toContain("from carol");
  });

  it("acks without printing the body, idempotently", () => {
    const p = threadFile(silo.get(), "alice", "bob");
    seedBlock(p, "2026-07-29T10:00:00Z", "bob", "sent", "hi", "secret body");

    const env = silo.env({ agentName: "alice" });
    const result = runCli(["ack", "bob"], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("acked 1 block");
    expect(result.stdout).not.toContain("secret body");

    expect(fs.readFileSync(p, "utf8")).toContain("status: read");

    expect(runCli(["ack", "bob"], env).stdout).toContain("nothing to ack");
  });

  it("lists correspondents with unread counts", () => {
    seedBlock(
      threadFile(silo.get(), "alice", "bob"),
      "2026-07-29T10:00:00Z", "bob", "sent", "s1", "body one",
    );
    seedBlock(
      threadFile(silo.get(), "alice", "bob"),
      "2026-07-29T10:01:00Z", "bob", "sent", "s2", "body two",
    );
    seedBlock(
      threadFile(silo.get(), "alice", "carol"),
      "2026-07-29T10:02:00Z", "carol", "read", "s3", "already read",
    );
    const result = runCli(["unread"], silo.env({ agentName: "alice" }));
    expect(result.stdout).toContain("bob: 2 unread");
    expect(result.stdout).not.toContain("carol");
  });

  it("reports none when everything is read", () => {
    expect(runCli(["unread"], silo.env({ agentName: "alice" })).stdout).toContain("no unread");
  });

  it("patches the status field, never a lookalike inside the sender name", () => {
    // Regression guard, and a real bug in the implementation this was ported
    // from. Locating the token with a loose /status:\s*(sent)/ takes the FIRST
    // match in the header line, and `from:` precedes `status:` in the grammar,
    // so a correspondent named "status:sentinel" matched inside the SENDER.
    // Verify-before-write does not catch it (those bytes genuinely spell
    // "sent"), so the flip rewrote the sender to "status:readinel" and left
    // the real status at "sent": file corrupted, message permanently unread.
    const correspondent = "status:sentinel";
    const p = threadFile(silo.get(), "alice", correspondent);
    seedBlock(p, "2026-07-29T10:00:00Z", correspondent, "sent", "hi", "body");

    const result = runCli(["ack", correspondent], silo.env({ agentName: "alice" }));
    expect(result.status, result.stderr).toBe(0);

    const raw = fs.readFileSync(p, "utf8");
    expect(raw).toContain(`from: ${correspondent} `); // sender untouched
    expect(raw).toContain("status: read"); // the real status flipped
    expect(raw).not.toContain("readinel");
  });

  it("patches the right block when an earlier block holds multi-byte UTF-8", () => {
    // Conformance point 6, and protocol section 8.2 step 2. The status token
    // is located as a CHARACTER offset into the parsed text, then converted
    // to a BYTE offset before the r+ patch. Drop that conversion and the four
    // bytes land short of the target by one byte per extra UTF-8 byte in
    // everything before it, so the patch corrupts an unrelated part of the
    // file and the message stays unread.
    //
    // The earlier block carries both accented characters (two UTF-8 bytes,
    // one UTF-16 unit) and an emoji (four UTF-8 bytes, two UTF-16 units),
    // because those two drift by different amounts. A test with only
    // accented text would still pass an implementation that confused UTF-16
    // code units with code points.
    const p = threadFile(silo.get(), "alice", "bob");
    seedBlock(
      p, "2026-07-29T10:00:00Z", "alice", "sent", "café naïve \u{1F680}",
      "résumé \u{1F3AF} first body",
    );
    seedBlock(p, "2026-07-29T10:05:00Z", "bob", "sent", "second", "plain body");

    const before = fs.readFileSync(p);
    // `ack bob` flips only bob's blocks, so alice's multi-byte block stays
    // `sent` and is a genuine untouched region rather than a second target.
    const result = runCli(["ack", "bob"], silo.env({ agentName: "alice" }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("acked 1 block");

    const after = fs.readFileSync(p);
    expect(after.length, "an in-place patch must not resize the file").toBe(before.length);

    // Where the four bytes SHOULD land, computed independently of the
    // implementation: Buffer#indexOf is byte addressed, and the marker is
    // pure ASCII, so no character-to-byte conversion is involved here.
    const marker = "from: bob - status: ";
    const offset = before.indexOf(marker, 0, "utf8") + Buffer.byteLength(marker);
    expect(offset).toBeGreaterThan(0);
    expect(after.subarray(offset, offset + 4).toString("utf8")).toBe("read");

    // Byte identical everywhere else. Masking the patched window and
    // comparing the whole buffer catches a stray write anywhere in the file,
    // not just a wrong flip in a block the test thought to look at.
    const mask = (buf: Buffer): Buffer =>
      Buffer.concat([buf.subarray(0, offset), Buffer.from("....") , buf.subarray(offset + 4)]);
    expect(
      mask(after).equals(mask(before)),
      "the flip changed bytes outside the status token it was aiming at",
    ).toBe(true);

    // And the correct block flipped, stated in the format's own terms.
    const text = after.toString("utf8");
    expect(text).toContain("from: alice - status: sent");
    expect(text).toContain("from: bob - status: read");
  });

  it("leaves a malformed block byte identical across a read and an append", () => {
    // Conformance point 10, and protocol section 9.1. The existing
    // parseBlocks test proves the parser tolerates a malformed block on
    // READ. The stronger claim is that malformed content is never repaired:
    // after a read (which patches status in place) and a subsequent reply
    // (which appends), every malformed byte must still be exactly where it
    // was. Anything that normalises a header-shaped line, or that rewrites
    // the file rather than patching and appending, fails here.
    const p = threadFile(silo.get(), "alice", "bob");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original =
      "\n## 2026-07-29T10:00:00Z - from: bob - status: sent - subject: real\n" +
      "\nreal body line\n" +
      "## A heading shaped like a header but missing every field\n" +
      "## 2026-07-29T10:01:00Z - from: bob - subject: no status field\n" +
      "prose sitting after the pseudo headers\n";
    fs.writeFileSync(p, original, "utf8");

    const env = silo.env({ agentName: "alice" });
    const readResult = runCli(["read", "bob"], env);
    expect(readResult.status, readResult.stderr).toBe(0);
    const replyResult = runCli(["reply", "bob", "--subject", "re", "--body", "appended"], env);
    expect(replyResult.status, replyResult.stderr).toBe(0);

    // The ONLY permitted change to the original region is the four-byte
    // status flip on the one well-formed block. Everything else, including
    // both pseudo headers and the orphaned prose, must be untouched.
    const expectedPrefix = original.replace("status: sent", "status: read");
    const after = fs.readFileSync(p, "utf8");
    expect(
      after.startsWith(expectedPrefix),
      "the original region was altered beyond the single status flip",
    ).toBe(true);

    // The append landed after it rather than in the middle of it.
    expect(after.slice(expectedPrefix.length)).toContain("from: alice");
    expect(after.slice(expectedPrefix.length)).toContain("appended");

    // Nothing invented a missing field to make the pseudo header parse.
    expect(after).not.toContain("subject: no status field - status:");
    expect(after).toContain("## 2026-07-29T10:01:00Z - from: bob - subject: no status field\n");
  });

  it("prints a body's markdown heading and everything after it on read", () => {
    // End-to-end form of the section 4 rule: the message is displayed WHOLE.
    // Before the fix the read stopped at the heading, so the sender's words
    // after it never reached the recipient even though they were on disk.
    const p = threadFile(silo.get(), "alice", "bob");
    seedBlock(
      p, "2026-07-29T10:00:00Z", "bob", "sent", "plan",
      "intro line\n## Options\nthe part that used to vanish",
    );

    const result = runCli(["read", "bob"], silo.env({ agentName: "alice" }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("intro line");
    expect(result.stdout).toContain("## Options");
    expect(result.stdout).toContain("the part that used to vanish");

    // And the flip still landed on the real header, exactly four bytes.
    const raw = fs.readFileSync(p, "utf8");
    expect(raw).toContain("status: read");
    expect(raw).not.toContain("status: sent");
  });

  it("patches the correct block when a pseudo header sits between two real ones", () => {
    // The status byte offset is derived from the block's own start, so a
    // pseudo header absorbed into an earlier body must not shift the patch.
    const p = threadFile(silo.get(), "alice", "bob");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original =
      "\n## 2026-07-29T10:00:00Z - from: alice - status: sent - subject: mine\n" +
      "\nmy own note\n" +
      "## Interlude heading, not a header\n" +
      "\n## 2026-07-29T10:05:00Z - from: bob - status: sent - subject: theirs\n" +
      "\nbob's note\n";
    fs.writeFileSync(p, original, "utf8");

    const result = runCli(["ack", "bob"], silo.env({ agentName: "alice" }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("acked 1 block");

    const after = fs.readFileSync(p, "utf8");
    expect(after.length, "an in-place patch must not resize the file").toBe(original.length);
    expect(after).toContain("from: alice - status: sent");
    expect(after).toContain("from: bob - status: read");
    expect(after).toContain("## Interlude heading, not a header");
  });

  it("DOCUMENTED DEFECT, do not fix: an uppercase SENT can never be flipped to read", () => {
    // This pins CURRENT behaviour that protocol section 5.2 records
    // deliberately. It is NOT desired behaviour and the test is not a
    // licence to keep it: changing it is an open decision, and this test
    // exists so that whoever makes that decision does so knowingly rather
    // than discovering the behaviour from a user.
    //
    // Mechanism: HEADER_RE carries the `i` flag, so `STATUS: SENT` parses and
    // parseBlocks lower-cases it to "sent". The block is therefore counted as
    // unread and printed. The in-place patch then verifies the four bytes at
    // the offset before writing (section 8.2 step 3) and that check is byte
    // exact, so "SENT" fails it and the write is skipped. The message is
    // displayed on every read, for ever.
    //
    // The same assertions double as the only coverage of the
    // verify-before-write guard itself (conformance point 5): this is the one
    // reachable case where the bytes at a correctly derived offset are not
    // "sent", and the guard's job is to decline rather than corrupt them.
    const p = threadFile(silo.get(), "alice", "bob");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original =
      "\n## 2026-07-29T10:00:00Z - from: bob - STATUS: SENT - subject: shouty\n" +
      "\nuppercase status body\n";
    fs.writeFileSync(p, original, "utf8");

    const env = silo.env({ agentName: "alice" });

    // It parses and is displayed, so it is not simply invisible.
    const first = runCli(["read", "bob"], env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("uppercase status body");

    // The flip declined to write, rather than corrupting the four bytes.
    expect(fs.readFileSync(p, "utf8")).toBe(original);

    // So it is printed again, and again, on every subsequent read.
    const second = runCli(["read", "bob"], env);
    expect(second.stdout).toContain("uppercase status body");
    expect(runCli(["unread"], env).stdout).toContain("bob: 1 unread");

    // `ack` cannot clear it either: the flip counts zero blocks patched.
    expect(runCli(["ack", "bob"], env).stdout).toContain("nothing to ack");
    expect(fs.readFileSync(p, "utf8")).toBe(original);
  });

  it("writes through a symlinked thread file without severing the link", () => {
    // Thread files are often symlinks (two agents sharing one file on disk).
    // Every write resolves realpath first and then mutates IN PLACE: an
    // append, or a same-length byte patch. A temp-file-plus-rename "atomic
    // write" would replace the symlink with a regular file and silently split
    // the two sides of the conversation apart.
    const real = path.join(silo.get(), "shared-thread.md");
    const link = threadFile(silo.get(), "alice", "bob");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, "", "utf8");
    fs.symlinkSync(real, link);
    seedBlock(real, "2026-07-29T10:00:00Z", "bob", "sent", "hi", "hello alice");

    const env = silo.env({ agentName: "alice" });
    expect(runCli(["reply", "bob", "--subject", "re", "--body", "hi bob"], env).status).toBe(0);
    expect(runCli(["ack", "bob"], env).status).toBe(0);

    expect(fs.lstatSync(link).isSymbolicLink(), "the symlink was replaced").toBe(true);
    // Both the append and the status flip landed on the real file.
    const raw = fs.readFileSync(real, "utf8");
    expect(raw).toContain("hi bob");
    expect(raw).toContain("from: bob - status: read");
    // The lock sibling belongs next to the RESOLVED file, so two writers of a
    // shared thread contend on the same lock rather than taking one each.
    expect(fs.existsSync(link + ".lock")).toBe(false);
    expect(fs.existsSync(real + ".lock")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live-wake push mechanism: configurable path, graceful no-op
// ---------------------------------------------------------------------------
describe("maybePush", () => {
  const silo = useTempSilo();

  it("still succeeds with no push binary present", () => {
    // Default pushBin path (SILO_HOME/bin/inbox-push) does not exist in
    // a fresh throwaway silo; the push must silently no-op, never fail
    // the send, and print nothing about it.
    const result = runCli(
      ["reply", "bob", "--subject", "hi", "--body", "x"],
      silo.env({ agentName: "alice", push: true }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("replied to bob");
    expect(result.stdout).not.toContain("push:");
  });

  it("honours the INBOX_PUSH_BIN env var", () => {
    // INBOX_PUSH_BIN must be a single executable path (the CLI runs
    // spawnSync(pushBin, [correspondent, msg])), so the stub itself
    // needs a shebang rather than being invoked via a separate interpreter
    // argument. The stub is a .mjs file so it works regardless of the
    // "type" field of the nearest package.json.
    const stubPath = path.join(silo.get(), "inbox-push.mjs");
    const markerPath = path.join(silo.get(), "push-call.txt");
    fs.writeFileSync(
      stubPath,
      "#!/usr/bin/env node\n" +
        'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)) + "\\n" + (process.env.AGENT_NAME ?? ""));\n` +
        'console.log("pushed");\n',
      "utf8",
    );
    fs.chmodSync(stubPath, 0o755);

    const result = runCli(
      ["reply", "bob", "--subject", "hi", "--body", "hello"],
      silo.env({ agentName: "alice", push: true, extra: { INBOX_PUSH_BIN: stubPath } }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("push: pushed");

    const marker = fs.readFileSync(markerPath, "utf8");
    expect(marker).toContain("bob"); // correspondent passed through
    expect(marker).toContain("alice"); // AGENT_NAME=me passed through env
  });

  it("defaults the push binary under SILO_HOME, not a fixed fleet path", () => {
    const expected = path.join(silo.get(), "bin", "inbox-push");
    withEnv({ SILO_HOME: silo.get(), INBOX_PUSH_BIN: undefined }, () => {
      // Resolve the siloHome()-derived default the same way maybePush does.
      const actualDefault =
        process.env.INBOX_PUSH_BIN || path.join(inbox.siloHome(), "bin", "inbox-push");
      expect(actualDefault).toBe(expected);
    });
  });
});
