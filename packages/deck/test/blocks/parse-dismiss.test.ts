/**
 * Unit tests for parse.ts: new fields dismissed, dismiss-reason, done-note.
 *
 * Covers:
 * - dismissed: present/absent/non-string (warn + undefined)
 * - dismiss-reason: present string / malformed JSON warns + plain-string fallback
 * - done-note: present string / malformed JSON warns + plain-string fallback
 * - existing fixture round-trip is unaffected (regression check)
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect, vi } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";

// ---------------------------------------------------------------------------
// Test blocks
// ---------------------------------------------------------------------------

const DISMISSED_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: test dismiss parse`,
  `action-id: parse-dismiss-test`,
  `dismissed: 2026-06-09T12:00:00Z`,
  `dismiss-reason: "Not relevant"`,
  ``,
  `Body text.`,
  ``,
  `---`,
].join("\n");

const DONE_NOTE_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: test done-note parse`,
  `action-id: parse-done-note-test`,
  `done: 2026-06-09T11:00:00Z`,
  `done-note: "Wrapped up via email"`,
  ``,
  `Body text.`,
  ``,
  `---`,
].join("\n");

const PLAIN_ACTION_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: plain action`,
  `action-id: plain-action`,
  `priority: high`,
  ``,
  `No dismissed or done-note fields.`,
  ``,
  `---`,
].join("\n");

// A bare unquoted YAML string (no surrounding quote chars). YAML parses it to a
// plain string; single-decode returns it verbatim, no warning.
const PLAIN_REASON_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: plain reason`,
  `action-id: plain-reason-test`,
  `dismissed: 2026-06-09T12:00:00Z`,
  `dismiss-reason: not-valid-json-string`,
  ``,
  `Body.`,
  ``,
  `---`,
].join("\n");

const PLAIN_NOTE_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: plain note`,
  `action-id: plain-note-test`,
  `done: 2026-06-09T11:00:00Z`,
  `done-note: not-valid-json-note`,
  ``,
  `Body.`,
  ``,
  `---`,
].join("\n");

// ---------------------------------------------------------------------------
// Suite: dismissed field
// ---------------------------------------------------------------------------

describe("parseBlock - dismissed field", () => {
  it("parses dismissed: when present", () => {
    const block = parseBlock(DISMISSED_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.dismissed).toBe("2026-06-09T12:00:00Z");
  });

  it("dismissed is undefined when absent", () => {
    const block = parseBlock(PLAIN_ACTION_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.dismissed).toBeUndefined();
  });

  it("parses dismiss-reason from JSON string", () => {
    const block = parseBlock(DISMISSED_BLOCK);
    expect(block.actionCard!.dismissReason).toBe("Not relevant");
  });

  it("dismissReason is undefined on plain action block", () => {
    const block = parseBlock(PLAIN_ACTION_BLOCK);
    expect(block.actionCard!.dismissReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: done-note field
// ---------------------------------------------------------------------------

describe("parseBlock - done-note field", () => {
  it("parses done-note: from JSON string", () => {
    const block = parseBlock(DONE_NOTE_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.doneNote).toBe("Wrapped up via email");
  });

  it("doneNote is undefined when absent", () => {
    const block = parseBlock(PLAIN_ACTION_BLOCK);
    expect(block.actionCard!.doneNote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: plain (non-JSON-quoted) string handling
//
// YAML already decodes the meta value, so a bare unquoted string round-trips as
// itself with no second JSON.parse and no warning. (Previously these blocks were
// framed as "malformed JSON" and expected to warn - that pinned the redundant
// double-decode which stripped quote chars off a note whose text was itself a
// JSON string literal. The double-decode is gone; single-decode is correct.)
// ---------------------------------------------------------------------------

describe("parseBlock - plain string meta values (CARD-05)", () => {
  it("bare dismiss-reason string is returned verbatim, never throws, no warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let block: ReturnType<typeof parseBlock> | undefined;
    expect(() => {
      block = parseBlock(PLAIN_REASON_BLOCK);
    }).not.toThrow();
    expect(block!.actionCard).toBeDefined();
    expect(block!.actionCard!.dismissReason).toBe("not-valid-json-string");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("bare done-note string is returned verbatim, never throws, no warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let block: ReturnType<typeof parseBlock> | undefined;
    expect(() => {
      block = parseBlock(PLAIN_NOTE_BLOCK);
    }).not.toThrow();
    expect(block!.actionCard).toBeDefined();
    expect(block!.actionCard!.doneNote).toBe("not-valid-json-note");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Suite: regression - existing blocks unaffected
// ---------------------------------------------------------------------------

describe("parseBlock - regression: existing blocks unaffected", () => {
  it("plain action block parses with no dismissed/doneNote fields", () => {
    const block = parseBlock(PLAIN_ACTION_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.actionId).toBe("plain-action");
    expect(block.actionCard!.dismissed).toBeUndefined();
    expect(block.actionCard!.dismissReason).toBeUndefined();
    expect(block.actionCard!.doneNote).toBeUndefined();
  });
});
