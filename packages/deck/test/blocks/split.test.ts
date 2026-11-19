/**
 * Regression tests for the three ways splitBlocks has lost message content.
 *
 * 1. A standalone "---" line inside a message body silently truncated the
 *    rendered message in Deck, dropping everything after it (reported by the
 *    operator twice). Two independent bugs: splitBlocks used "---" as a block boundary
 *    (dropping content up to the next header), and _parseBlock cut the body at
 *    the FIRST "---".
 *
 * 2. A markdown heading in a message body did the same thing, from the other
 *    end of the same function: every line beginning "## " opened a block, so
 *    an ordinary heading someone typed ended their message early and the rest
 *    of it re-appeared as a block with no sender. The
 *    python3 CLI in packages/base had the identical defect, was fixed there
 *    first, and the fix came across with a matching regression pin (Case 52 in
 *    packages/base/test/inbox.test.sh). Corpus cases body-markdown-heading and
 *    pseudo-header-between-blocks state it against docs/protocol.md.
 *
 * 3. Bounding on the header GRAMMAR rather than the "## " prefix (the fix for
 *    2) was first written as HEADER_RE.test(line.trim()), and the trim was the
 *    next defect: HEADER_RE requires a space after `subject:`, serializeHeader
 *    emits exactly one and nothing else when the subject is empty, and trim
 *    takes it back off. An empty-subject header stopped opening a block and
 *    was absorbed into the message above it, under that message's sender.
 *    Stripping only LEADING whitespace keeps the indentation tolerance that
 *    trim was there for without touching the end of the line.
 *
 * These tests drive the FULL pipeline (splitBlocks -> parseBlock) from a
 * multi-block raw string, which is the only way to exercise ALL THREE bugs: a
 * parseBlock-only test on a hand-built single block would never touch the split
 * stage.
 */
import { describe, it, expect } from "vitest";
import { splitBlocks } from "~/lib/blocks/split.js";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeHeader } from "~/lib/blocks/header.js";

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

describe("a body markdown heading is not a block boundary", () => {
  it("keeps the message whole and does not invent a second, senderless block", () => {
    const raw = [
      "## 2026-08-13T10:00:00Z - from: scribe - status: sent - subject: plan",
      "",
      "Here is my message.",
      "",
      "## A markdown heading someone typed",
      "",
      "This trailing paragraph is AFTER the heading and must survive.",
      "",
      "---",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    // ONE block. Two is the bug: the heading opened a second block whose
    // header could not parse, so it rendered under a blank sender - the
    // "message from someone who does not exist" this was found as.
    expect(blocks).toHaveLength(1);

    const only = parseBlock(blocks[0]!);
    expect(only.header.from).toBe("scribe");
    expect(only.header.subject).toBe("plan");
    expect(only.body).toBe(
      "Here is my message.\n\n## A markdown heading someone typed\n\n" +
        "This trailing paragraph is AFTER the heading and must survive."
    );
  });

  it("absorbs a pseudo header BETWEEN two real blocks without disturbing the second", () => {
    const raw = [
      "## 2026-08-13T10:00:00Z - from: alice - status: sent - subject: mine",
      "",
      "my own note",
      "",
      "## Interlude heading, not a header",
      "",
      "## 2026-08-13T10:05:00Z - from: bob - status: sent - subject: theirs",
      "",
      "bob's note",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(2);

    // The pseudo header belongs to alice's body; a real header still opens its
    // own block immediately after one, so the fix cannot swallow live messages.
    const first = parseBlock(blocks[0]!);
    expect(first.header.from).toBe("alice");
    expect(first.body).toBe("my own note\n\n## Interlude heading, not a header");

    const second = parseBlock(blocks[1]!);
    expect(second.header.from).toBe("bob");
    expect(second.header.subject).toBe("theirs");
    expect(second.body).toBe("bob's note");
  });

  it("survives an embedded code example whose lines start with ## ", () => {
    // The live shape: an agent quoting the message format itself inside a
    // fence. The quoted line here is the GRAMMAR, with placeholders, so it
    // does not parse (`<sent|read>` is not a status value) and no longer bounds
    // a block. The fence arrives at the reader intact.
    //
    // Scope note: a header quoted with CONCRETE, well-formed values still
    // parses, so it still opens a block and still misattributes the prose
    // after it, fence or no fence. That is a separate defect (misattribution,
    // not loss - no bytes go missing) and closing it needs a write-time
    // change, not fence detection in the reader.
    const raw = [
      "## 2026-08-13T11:00:00Z - from: scribe - status: sent - subject: format",
      "",
      "The header looks like this:",
      "",
      "```",
      "## <timestamp> - from: <name> - status: <sent|read> - subject: <subject>",
      "```",
      "",
      "## Why it matters",
      "",
      "Everything from the fence down used to vanish.",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(1);

    const only = parseBlock(blocks[0]!);
    expect(only.header.from).toBe("scribe");
    expect(only.body).toContain("## <timestamp> - from: <name>");
    expect(only.body).toContain("## Why it matters");
    expect(only.body).toContain("Everything from the fence down used to vanish.");
  });
});

describe("an empty subject does not stop a header opening a block", () => {
  // The line under test is produced by the writer rather than typed out here.
  // An empty-subject header ends in the space after "subject:" and nothing
  // else; that space is invisible in a source file and is the first thing an
  // editor or formatter that strips trailing whitespace takes away - and
  // taking it away leaves a test that still passes while no longer testing
  // this. serializeHeader cannot drift from what the reader must accept, and
  // the shape is asserted below rather than assumed.
  const emptySubjectHeader = serializeHeader({
    timestamp: "2026-08-17T09:05:00Z",
    from: "atlas",
    status: "read",
    subject: "",
  });

  it("the writer emits a line ending in the space HEADER_RE requires", () => {
    expect(emptySubjectHeader.endsWith("subject: ")).toBe(true);
  });

  it("keeps its own block between two ordinary ones", () => {
    const raw = [
      "## 2026-08-17T09:00:00Z - from: scribe - status: sent - subject: opener",
      "",
      "First block body.",
      "",
      "---",
      emptySubjectHeader,
      "",
      "The message with no subject.",
      "",
      "---",
      "## 2026-08-17T09:10:00Z - from: courier - status: sent - subject: closer",
      "",
      "Third block body.",
      "",
      "---",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    // Two is the bug: a fully trimmed line no longer satisfies `subject:\s+`,
    // so the middle header failed the boundary test and its message was served
    // as the tail of the block above it, over scribe's name.
    expect(blocks).toHaveLength(3);

    const first = parseBlock(blocks[0]!);
    expect(first.header.from).toBe("scribe");
    expect(first.body).toBe("First block body.");

    const middle = parseBlock(blocks[1]!);
    expect(middle.header.from).toBe("atlas");
    expect(middle.header.subject).toBe("");
    expect(middle.body).toBe("The message with no subject.");

    const last = parseBlock(blocks[2]!);
    expect(last.header.from).toBe("courier");
    expect(last.body).toBe("Third block body.");
  });

  it("opens the file when it is the first and only header", () => {
    // The costlier half of the same defect. With nothing above it to be
    // absorbed into, an unrecognised sole header leaves no headers at all, and
    // a file with no blocks renders as an empty thread: the whole conversation
    // gone from the view, not merely attributed to the wrong sender.
    const raw = [
      emptySubjectHeader,
      "",
      "The only message in the file.",
      "",
      "---",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(1);

    const only = parseBlock(blocks[0]!);
    expect(only.header.from).toBe("atlas");
    expect(only.header.subject).toBe("");
    expect(only.body).toBe("The only message in the file.");
  });

  it("still treats an indented well-formed header as a boundary", () => {
    // The other side of the same expression, pinned here because the two are
    // one decision: leading whitespace is stripped, trailing whitespace is
    // not. Bounding on an indented header is a known departure from protocol
    // section 4 (corpus case indented-pseudo-header), so it is deliberate
    // behaviour to preserve, not incidental - a "fix" that stopped stripping
    // whitespace altogether would change it silently.
    const raw = [
      "## 2026-08-17T10:00:00Z - from: scribe - status: sent - subject: outer",
      "",
      "body line",
      "  ## 2026-08-17T10:05:00Z - from: courier - status: sent - subject: indented",
      "more body",
      "",
    ].join("\n");

    const blocks = splitBlocks(raw);
    expect(blocks).toHaveLength(2);
    expect(parseBlock(blocks[0]!).body).toBe("body line");
    // Asserted on the split output, not through parseBlock: the block the
    // indented line opens keeps its indentation, and parseHeader is anchored at
    // column 0, so it goes on to parse as a plain bubble. Splitting there at
    // all is the behaviour under test.
    expect(blocks[1]!.startsWith("  ## 2026-08-17T10:05:00Z")).toBe(true);
  });
});
