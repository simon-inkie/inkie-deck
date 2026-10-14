/**
 * RED tests: malformed or partial card frontmatter falls back to a plain bubble.
 * parseBlock NEVER throws on any input.
 * Ref: T-01-03 (DoS - parseBlock on malformed card)
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";

const TIMESTAMP = "2026-06-09T14:30:00Z";

/** Build a minimal valid block string for testing. */
function makeBlock(meta: string, body: string): string {
  const header = `## ${TIMESTAMP} - from: test-agent - status: sent - subject: test`;
  if (meta) {
    return `${header}\n${meta}\n\n${body}\n\n---`;
  }
  return `${header}\n${body}\n\n---`;
}

describe("parseBlock - plain bubble cases (no card, no error)", () => {
  it("plain message block (no metadata) parses as bubble without error", () => {
    const block = makeBlock("", "Hello from the agent.");
    expect(() => parseBlock(block)).not.toThrow();
    const result = parseBlock(block);
    expect(result.card).toBeUndefined();
    expect(result.body).toContain("Hello from the agent.");
    expect(result.rawMeta).toBe("");
  });

  it("block with ONLY non-card metadata (no decision-id) parses as bubble", () => {
    const block = makeBlock("blocking: true\nlean: maybe", "Some discussion.");
    expect(() => parseBlock(block)).not.toThrow();
    const result = parseBlock(block);
    expect(result.card).toBeUndefined();
    expect(result.rawMeta).toContain("blocking:");
  });
});

describe("CARD-05: malformed card always falls back to bubble, never throws", () => {
  it("missing decision-id falls back to bubble", () => {
    const meta = `options:\n  - key: A\n    label: "Option A"\n    detail: "Detail A."`;
    const block = makeBlock(meta, "Choose an option.");
    expect(() => parseBlock(block)).not.toThrow();
    expect(parseBlock(block).card).toBeUndefined();
  });

  it("empty options array falls back to bubble", () => {
    const meta = `decision-id: TASK-001-q1\noptions: []`;
    const block = makeBlock(meta, "No options.");
    expect(() => parseBlock(block)).not.toThrow();
    expect(parseBlock(block).card).toBeUndefined();
  });

  it("invalid YAML falls back to bubble without throwing", () => {
    // Deliberately malformed YAML (unbalanced quotes)
    const meta = `decision-id: "broken\noptions: [bad`;
    const block = makeBlock(meta, "Broken YAML.");
    expect(() => parseBlock(block)).not.toThrow();
    expect(parseBlock(block).card).toBeUndefined();
  });

  it("options that are not an array falls back to bubble", () => {
    const meta = `decision-id: TASK-001-q1\noptions: "not an array"`;
    const block = makeBlock(meta, "Wrong options type.");
    expect(() => parseBlock(block)).not.toThrow();
    expect(parseBlock(block).card).toBeUndefined();
  });

  it("option missing key field falls back to bubble", () => {
    const meta = `decision-id: TASK-001-q1\noptions:\n  - label: "No key"\n    detail: "Missing key."`;
    const block = makeBlock(meta, "Incomplete option.");
    expect(() => parseBlock(block)).not.toThrow();
    expect(parseBlock(block).card).toBeUndefined();
  });

  it("completely empty block string parses without throwing", () => {
    expect(() => parseBlock("")).not.toThrow();
  });

  it("block with only whitespace parses without throwing", () => {
    expect(() => parseBlock("   \n  \n  ")).not.toThrow();
  });
});

describe("phantom-dot regression: unparseable headers default to status read", () => {
  // Operator report: quill/atlas showed a magenta unread dot that opening
  // the thread hid but leaving re-showed. Root cause: a header with a blanked
  // timestamp fails parseHeader (Date.parse("") is NaN), so parseBlock fell back
  // to status "sent" - which the sidebar reads as unread, forever (markRead
  // re-serializes to the same blank header that fails parse again). The fallback
  // must be "read" so a block we cannot parse never nags.

  it("header with a blank timestamp (lossy re-serialize) parses to status read", () => {
    const block = "##  - from:  - status: read - subject: \n\nReal body that survived.\n\n---";
    const result = parseBlock(block);
    expect(result.header.status).toBe("read");
    expect(result.body).toContain("Real body that survived.");
  });

  it("header with a non-date timestamp parses to status read (not sent)", () => {
    const block = "## not-a-date - from: quill - status: sent - subject: hi\n\nBody.\n\n---";
    const result = parseBlock(block);
    // parseHeader rejects the bad timestamp; the whole header is discarded and
    // the safe fallback applies - read, so no phantom unread signal.
    expect(result.header.status).toBe("read");
  });

  it("completely empty block defaults to status read", () => {
    expect(parseBlock("").header.status).toBe("read");
  });
});

describe("parseBlock - header parsing", () => {
  it("parses header fields correctly", () => {
    const block = makeBlock("", "Body text.");
    const result = parseBlock(block);
    expect(result.header.timestamp).toBe(TIMESTAMP);
    expect(result.header.from).toBe("test-agent");
    expect(result.header.status).toBe("sent");
    expect(result.header.subject).toBe("test");
  });

  it("subject with hyphens is preserved correctly (no mis-split)", () => {
    const block = `## ${TIMESTAMP} - from: Scribe - status: read - subject: ad-spend week-2\n\nBody.\n\n---`;
    const result = parseBlock(block);
    expect(result.header.subject).toBe("ad-spend week-2");
    expect(result.header.from).toBe("Scribe");
  });

  it("hyphenated from-name is preserved (no mis-split)", () => {
    const block = `## ${TIMESTAMP} - from: my-agent-42 - status: sent - subject: hello\n\nBody.\n\n---`;
    const result = parseBlock(block);
    expect(result.header.from).toBe("my-agent-42");
    expect(result.header.subject).toBe("hello");
  });
});

describe("parseBlock - body-internal --- is preserved (truncation regression)", () => {
  // A "---" that is NOT the last non-blank line of the block is body content
  // (a visual divider), not the trailing separator. Scanning for the FIRST
  // "---" truncated such bodies in the MC render.

  it("keeps a mid-body --- line when a genuine trailing separator follows", () => {
    const block = [
      `## ${TIMESTAMP} - from: scribe - status: sent - subject: divider`,
      "",
      "Before the divider.",
      "",
      "---",
      "",
      "After the divider. Must survive.",
      "",
      "---",
    ].join("\n");
    const result = parseBlock(block);
    expect(result.body).toBe(
      "Before the divider.\n\n---\n\nAfter the divider. Must survive."
    );
  });

  it("keeps a mid-body --- when there is no trailing separator at all", () => {
    const block = [
      `## ${TIMESTAMP} - from: scribe - status: sent - subject: unterminated`,
      "",
      "Intro.",
      "",
      "---",
      "",
      "Trailing content, no closing separator.",
    ].join("\n");
    const result = parseBlock(block);
    expect(result.body).toBe(
      "Intro.\n\n---\n\nTrailing content, no closing separator."
    );
  });

  it("strips only the final --- when several appear in one body", () => {
    const block = [
      `## ${TIMESTAMP} - from: scribe - status: sent - subject: many`,
      "",
      "One.",
      "",
      "---",
      "",
      "Two.",
      "",
      "---",
    ].join("\n");
    const result = parseBlock(block);
    expect(result.body).toBe("One.\n\n---\n\nTwo.");
  });

  it("still strips the trailing --- in the normal (no internal divider) case", () => {
    const block = [
      `## ${TIMESTAMP} - from: scribe - status: sent - subject: normal`,
      "",
      "Just a plain body.",
      "",
      "---",
    ].join("\n");
    const result = parseBlock(block);
    expect(result.body).toBe("Just a plain body.");
  });
});

describe("parseBlock - valid card", () => {
  it("parses a fully valid card block", () => {
    const meta = [
      `decision-id: TASK-413-q1`,
      `blocking: true`,
      `options:`,
      `  - key: A`,
      `    label: "Option A"`,
      `    detail: "Detail for A."`,
      `  - key: B`,
      `    label: "Option B"`,
      `    detail: "Detail for B."`,
      `lean: "B"`,
    ].join("\n");
    const block = makeBlock(meta, "What do you think?");
    const result = parseBlock(block);
    expect(result.card).toBeDefined();
    expect(result.card?.decisionId).toBe("TASK-413-q1");
    expect(result.card?.options).toHaveLength(2);
    // Unknown fields must NOT be on the card object
    const card = result.card as unknown as Record<string, unknown>;
    expect("lean" in card).toBe(false);
    expect("blocking" in card).toBe(false);
    // But they ARE in rawMeta
    expect(result.rawMeta).toContain("lean:");
    expect(result.rawMeta).toContain("blocking:");
  });
});
