/**
 * RED tests for round-trip fidelity: parseBlock then serializeBlock is byte-identical.
 * Verifies that lean, blocking, and unknown fields survive round-trip unchanged.
 * Ref: T-01-04 (Tampering - dropping unknown fields)
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { splitBlocks } from "~/lib/blocks/split.js";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";

// Read the fixture once for all tests
const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "../../fixtures/inbox/scribe/inbox/alex.md"
);

let fixtureRaw = "";
let blocks: string[] = [];

beforeAll(() => {
  fixtureRaw = fs.readFileSync(FIXTURE_PATH, "utf8");
  blocks = splitBlocks(fixtureRaw);
});

describe("splitBlocks", () => {
  it("returns one entry per block (eight blocks in the fixture)", () => {
    // The fixture gained 3 blocks (working-superseded, agent-reply, live-working).
    expect(blocks).toHaveLength(8);
  });

  it("each block starts with ## (the block header)", () => {
    for (const block of blocks) {
      expect(block.trimStart()).toMatch(/^##\s/);
    }
  });
});

describe("parseBlock", () => {
  it("parses the INK card block with correct decisionId", () => {
    const parsed = parseBlock(blocks[0]!);
    expect(parsed.card).toBeDefined();
    expect(parsed.card?.decisionId).toBe("TASK-413-q1");
  });

  it("parses the INK card block with 2 options", () => {
    const parsed = parseBlock(blocks[0]!);
    expect(parsed.card?.options).toHaveLength(2);
  });

  it("parses the plain message block as a bubble (no card)", () => {
    const parsed = parseBlock(blocks[1]!);
    expect(parsed.card).toBeUndefined();
    expect(parsed.body).toBeTruthy();
  });

  it("parses the malformed block (missing decision-id) as a bubble (CARD-05)", () => {
    // The fixture grew: the malformed block is now index 6.
    const parsed = parseBlock(blocks[6]!);
    expect(parsed.card).toBeUndefined();
    expect(parsed.body).toBeTruthy();
  });
});

describe("round-trip fidelity (serializeBlock(parseBlock(x)) === x)", () => {
  it("card block round-trips byte-for-byte", () => {
    const original = blocks[0]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("plain message block round-trips byte-for-byte", () => {
    const original = blocks[1]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("malformed block round-trips byte-for-byte", () => {
    // The fixture grew: the malformed block is now index 6.
    const original = blocks[6]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("rawMeta preserves lean and blocking verbatim (unknown fields not dropped)", () => {
    const parsed = parseBlock(blocks[0]!);
    // lean and blocking live in rawMeta, not in card
    expect(parsed.rawMeta).toContain("lean:");
    expect(parsed.rawMeta).toContain("blocking:");
    // The card object only has known fields
    const cardObj = parsed.card as unknown as Record<string, unknown>;
    expect("lean" in cardObj).toBe(false);
    expect("blocking" in cardObj).toBe(false);
  });

  it("the pound sign (£) and multi-line detail survive round-trip", () => {
    const original = blocks[0]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toContain("£");
    expect(serialized).toBe(original);
  });
});
