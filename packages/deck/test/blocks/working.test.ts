/**
 * working.test.ts - Unit tests for app/lib/blocks/working.ts.
 *
 * Covers:
 *   - isSuperseded: matrix of block orderings.
 *   - bubbleReceiptState: all status x superseded combinations.
 *   - Parse + round-trip: a status: working block parses and serializes byte-identically.
 *   - Fixture regression: the working blocks in the scribe fixture parse correctly.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isSuperseded, bubbleReceiptState, workingAgeSuffix } from "~/lib/blocks/working.js";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { splitBlocks } from "~/lib/blocks/split.js";
import type { MessageBlock } from "~/lib/blocks/model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMESTAMP = "2026-06-09T14:30:00Z";

function makeBlock(from: string, status: "sent" | "read" | "working", body = "test"): MessageBlock {
  const raw = `## ${TIMESTAMP} - from: ${from} - status: ${status} - subject: test\n\n${body}\n\n---`;
  return parseBlock(raw);
}

// ---------------------------------------------------------------------------
// isSuperseded
// ---------------------------------------------------------------------------

describe("isSuperseded", () => {
  it("returns false when block is last in thread", () => {
    const blocks = [makeBlock("alex", "sent"), makeBlock("alex", "working")];
    expect(isSuperseded(blocks, 1)).toBe(false);
  });

  it("returns false when all blocks after are from alex", () => {
    const blocks = [
      makeBlock("alex", "working"),
      makeBlock("alex", "sent"),
      makeBlock("alex", "sent"),
    ];
    expect(isSuperseded(blocks, 0)).toBe(false);
  });

  it("returns true when the immediately following block is from a non-alex sender", () => {
    const blocks = [
      makeBlock("alex", "working"),
      makeBlock("scribe", "sent"),
    ];
    expect(isSuperseded(blocks, 0)).toBe(true);
  });

  it("returns true when a non-alex block appears later (not immediately after)", () => {
    const blocks = [
      makeBlock("alex", "working"),
      makeBlock("alex", "sent"),
      makeBlock("atlas", "sent"),
    ];
    expect(isSuperseded(blocks, 0)).toBe(true);
  });

  it("returns false for a block at the edge of a non-alex sender followed by alex only", () => {
    const blocks = [
      makeBlock("scribe", "sent"),
      makeBlock("alex", "working"),
      makeBlock("alex", "sent"),
    ];
    // Block 1 (working) has only alex blocks after it.
    expect(isSuperseded(blocks, 1)).toBe(false);
  });

  it("returns false for a single-block thread", () => {
    const blocks = [makeBlock("alex", "working")];
    expect(isSuperseded(blocks, 0)).toBe(false);
  });

  it("returns false for an empty array (index out of range)", () => {
    expect(isSuperseded([], 0)).toBe(false);
  });

  it("returns false when index points to the last block in a multi-block thread", () => {
    const blocks = [
      makeBlock("alex", "sent"),
      makeBlock("alex", "working"),
    ];
    expect(isSuperseded(blocks, 1)).toBe(false);
  });

  it("correctly identifies the summit bad-card block as making prior blocks superseded", () => {
    // The fixture has a summit block (non-alex) near the end. Any alex working
    // block before it is superseded.
    const blocks = [
      makeBlock("alex", "working"),
      makeBlock("summit", "sent"),
    ];
    expect(isSuperseded(blocks, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bubbleReceiptState
// ---------------------------------------------------------------------------

describe("bubbleReceiptState", () => {
  it("working + not superseded -> working", () => {
    const block = makeBlock("alex", "working");
    expect(bubbleReceiptState(block, false)).toBe("working");
  });

  it("working + superseded -> read", () => {
    const block = makeBlock("alex", "working");
    expect(bubbleReceiptState(block, true)).toBe("read");
  });

  it("read + not superseded -> read", () => {
    const block = makeBlock("alex", "read");
    expect(bubbleReceiptState(block, false)).toBe("read");
  });

  it("read + superseded -> read (superseded has no effect on read)", () => {
    const block = makeBlock("alex", "read");
    expect(bubbleReceiptState(block, true)).toBe("read");
  });

  it("sent + not superseded -> sent", () => {
    const block = makeBlock("alex", "sent");
    expect(bubbleReceiptState(block, false)).toBe("sent");
  });

  it("sent + superseded -> sent (superseded has no effect on sent)", () => {
    const block = makeBlock("alex", "sent");
    expect(bubbleReceiptState(block, true)).toBe("sent");
  });

  it("unknown status -> sent (conservative fallback)", () => {
    // Simulate a block with an unrecognised status by overriding after parse.
    const block = makeBlock("alex", "sent");
    const mutated: MessageBlock = {
      ...block,
      header: { ...block.header, status: "sent" }, // stays sent - unknown path tested below
    };
    // Force-override status to simulate a future unknown value reaching the function.
    const unknown = { ...mutated, header: { ...mutated.header, status: "unknown" as "sent" } };
    expect(bubbleReceiptState(unknown, false)).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Parse + round-trip: status: working block
// ---------------------------------------------------------------------------

describe("working block parse + round-trip", () => {
  const RAW_WORKING =
    "## 2026-06-09T15:35:00Z - from: alex - status: working - subject: live working\n\nCan you check the wholesale numbers too?\n\n---";

  it("parses a working block without throwing", () => {
    expect(() => parseBlock(RAW_WORKING)).not.toThrow();
  });

  it("parses the status as working", () => {
    const parsed = parseBlock(RAW_WORKING);
    expect(parsed.header.status).toBe("working");
  });

  it("parses the from field correctly", () => {
    const parsed = parseBlock(RAW_WORKING);
    expect(parsed.header.from).toBe("alex");
  });

  it("parses the body correctly", () => {
    const parsed = parseBlock(RAW_WORKING);
    expect(parsed.body).toBe("Can you check the wholesale numbers too?");
  });

  it("round-trips byte-identically (serializeBlock(parseBlock(x)) === x)", () => {
    const parsed = parseBlock(RAW_WORKING);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(RAW_WORKING);
  });

  it("unknown status falls back to read on header parse failure (no regex match)", () => {
    // A header with an unrecognised status does not match HEADER_RE and falls
    // back to the empty-header sentinel. The sentinel status is "read" (not
    // "sent"): an unparseable block must never generate a perpetual unread
    // signal.
    const rawUnknown =
      "## 2026-06-09T15:35:00Z - from: alex - status: pondering - subject: test\n\nBody.\n\n---";
    const parsed = parseBlock(rawUnknown);
    // Header parse failed -> sentinel status "read"
    expect(parsed.header.status).toBe("read");
    expect(parsed.header.from).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Fixture regression: the two new working blocks parse correctly
// ---------------------------------------------------------------------------

describe("fixture regression: working blocks in the scribe fixture", () => {
  const FIXTURE_PATH = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../../fixtures/inbox/scribe/inbox/alex.md"
  );

  let blocks: string[];

  beforeAll(() => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
    blocks = splitBlocks(raw);
  });

  it("fixture has 8 blocks after TASK-444 additions", () => {
    expect(blocks).toHaveLength(8);
  });

  it("block 4 (working-superseded) parses with status: working", () => {
    const parsed = parseBlock(blocks[4]!);
    expect(parsed.header.status).toBe("working");
    expect(parsed.header.from).toBe("alex");
    expect(parsed.header.subject).toBe("working superseded");
  });

  it("block 5 (agent reply) has from: scribe (makes block 4 superseded)", () => {
    const parsed = parseBlock(blocks[5]!);
    expect(parsed.header.from).toBe("scribe");
  });

  it("block 6 (malformed summit block) still parses as plain bubble", () => {
    const parsed = parseBlock(blocks[6]!);
    expect(parsed.card).toBeUndefined();
    expect(parsed.body).toBeTruthy();
  });

  it("block 7 (live-working, last block) parses with status: working", () => {
    const parsed = parseBlock(blocks[7]!);
    expect(parsed.header.status).toBe("working");
    expect(parsed.header.from).toBe("alex");
    expect(parsed.header.subject).toBe("live working");
  });

  it("isSuperseded(blocks, 4) is true because block 5 is from scribe", () => {
    const parsedBlocks = blocks.map((b) => parseBlock(b));
    expect(isSuperseded(parsedBlocks, 4)).toBe(true);
  });

  it("isSuperseded(blocks, 7) is false because block 7 is the last block", () => {
    const parsedBlocks = blocks.map((b) => parseBlock(b));
    expect(isSuperseded(parsedBlocks, 7)).toBe(false);
  });

  it("block 4 round-trips byte-identically", () => {
    const original = blocks[4]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("block 7 round-trips byte-identically", () => {
    const original = blocks[7]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// workingAgeSuffix
// ---------------------------------------------------------------------------

describe("workingAgeSuffix - stale-working self-disclosure", () => {
  const now = new Date("2026-06-10T20:30:00Z");

  it("empty within the first hour (59 minutes)", () => {
    expect(workingAgeSuffix("2026-06-10T19:31:00Z", now)).toBe("");
  });

  it("empty at exactly one hour", () => {
    expect(workingAgeSuffix("2026-06-10T19:30:00Z", now)).toBe("");
  });

  it("discloses SENT age past one hour (61 minutes)", () => {
    const suffix = workingAgeSuffix("2026-06-10T19:29:00Z", now);
    expect(suffix).toMatch(/^ - sent .+ ago$/);
  });

  it("day-old message reads as sent about a day ago, never as work duration", () => {
    const suffix = workingAgeSuffix("2026-06-09T20:30:00Z", now);
    expect(suffix).toContain("sent");
    expect(suffix).toContain("day");
    expect(suffix).toMatch(/ago$/);
  });

  it("malformed timestamp degrades to empty (never NaN in a label)", () => {
    expect(workingAgeSuffix("not-a-date", now)).toBe("");
  });
});
