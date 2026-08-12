/**
 * Regression tests for the body-internal "---" truncation bug.
 *
 * A standalone "---" line inside a message body silently truncated the rendered
 * message in MC, dropping everything after it (hit Alex 1 + 15 Jul). Two
 * independent bugs: splitBlocks used "---" as a block boundary (dropping content
 * up to the next header), and _parseBlock cut the body at the FIRST "---".
 *
 * These tests drive the FULL pipeline (splitBlocks -> parseBlock) from a
 * multi-block raw string, which is the only way to exercise BOTH bugs: a
 * parseBlock-only test on a hand-built single block would never touch the split
 * stage.
 */
import { describe, it, expect } from "vitest";
import { splitBlocks } from "~/lib/blocks/split.js";
import { parseBlock } from "~/lib/blocks/parse.js";

describe("body-internal --- is preserved (not a block/body boundary)", () => {
  it("mid-body --- followed by more content, a trailing separator, then a second block", () => {
    const raw = [
      "## 2026-07-15T10:00:00Z - from: scribe - status: sent - subject: divider body",
      "",
      "First paragraph before the divider.",
      "",
      "---",
      "",
      "Second paragraph after the divider. This must survive.",
      "",
      "---",
      "## 2026-07-15T10:05:00Z - from: atlas - status: read - subject: next",
      "",
      "The following block must parse independently.",
      "",
      "---",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(2);

    // Block 1: the whole body survives, including the mid-body "---" line and
    // everything after it. Only the genuine trailing separator is stripped.
    const first = parseBlock(blocks[0]!);
    expect(first.header.from).toBe("scribe");
    expect(first.body).toContain("First paragraph before the divider.");
    expect(first.body).toContain("---");
    expect(first.body).toContain(
      "Second paragraph after the divider. This must survive."
    );
    expect(first.body).toBe(
      "First paragraph before the divider.\n\n---\n\nSecond paragraph after the divider. This must survive."
    );

    // Block 2 parses correctly and independently.
    const second = parseBlock(blocks[1]!);
    expect(second.header.from).toBe("atlas");
    expect(second.header.subject).toBe("next");
    expect(second.body).toBe("The following block must parse independently.");
  });

  it("mid-body --- in the LAST/unterminated block (no trailing separator)", () => {
    const raw = [
      "## 2026-07-15T11:00:00Z - from: summit - status: sent - subject: unterminated",
      "",
      "Intro line.",
      "",
      "---",
      "",
      "Trailing content with no closing separator at all.",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(1);

    const only = parseBlock(blocks[0]!);
    expect(only.header.from).toBe("summit");
    // No trailing "---" line, so the whole remainder is body, divider included.
    expect(only.body).toBe(
      "Intro line.\n\n---\n\nTrailing content with no closing separator at all."
    );
  });

  it("multiple bare --- lines in one body: only the final one before the next header is stripped", () => {
    const raw = [
      "## 2026-07-15T12:00:00Z - from: sprout - status: sent - subject: many dividers",
      "",
      "Section one.",
      "",
      "---",
      "",
      "Section two.",
      "",
      "---",
      "",
      "Section three.",
      "",
      "---",
      "## 2026-07-15T12:10:00Z - from: forge - status: read - subject: after",
      "",
      "Second block body.",
      "",
      "---",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(2);

    const first = parseBlock(blocks[0]!);
    // Both internal "---" dividers survive; only the genuine trailing one is gone.
    expect(first.body).toBe(
      "Section one.\n\n---\n\nSection two.\n\n---\n\nSection three."
    );

    const second = parseBlock(blocks[1]!);
    expect(second.header.from).toBe("forge");
    expect(second.body).toBe("Second block body.");
  });
});
