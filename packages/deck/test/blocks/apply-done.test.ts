/**
 * Unit tests for applyDone (app/lib/blocks/answer.ts).
 *
 * Covers:
 * - First application: done: <ISO> appended to rawMeta, body byte-identical
 * - Idempotence: second applyDone returns alreadyDone with existing timestamp
 * - Byte-identity of unknown rawMeta keys (fence-bounded discipline)
 * - Decoy: "done:" in body is NOT treated as done state (fence-bounded guard)
 * - Round-trip via serialize: body survives
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { applyDone } from "~/lib/blocks/answer.js";

const FIXED_ISO = "2026-06-09T12:00:00Z";

const ACTION_BLOCK_RAW = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
  `action-id: TASK-438-spec-review`,
  `priority: high`,
  ``,
  `Please review and confirm before implementation.`,
  ``,
  `---`,
].join("\n");

describe("applyDone - first application", () => {
  it("returns markedDone (not alreadyDone) on first apply", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDone(block, FIXED_ISO);
    expect("alreadyDone" in result).toBe(false);
    if ("markedDone" in result) {
      expect(result.markedDone).toBeDefined();
      expect(result.doneAt).toBe(FIXED_ISO);
    }
  });

  it("appends 'done: <ISO>' to rawMeta", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDone(block, FIXED_ISO);
    if ("markedDone" in result) {
      expect(result.markedDone.rawMeta).toContain(`done: ${FIXED_ISO}`);
    }
  });

  it("preserves existing rawMeta lines byte-identical (fence-bounded)", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDone(block, FIXED_ISO);
    if ("markedDone" in result) {
      // Original rawMeta lines must still be present
      expect(result.markedDone.rawMeta).toContain("action-id: TASK-438-spec-review");
      expect(result.markedDone.rawMeta).toContain("priority: high");
    }
  });

  it("body is byte-identical (fence-bounded: only rawMeta touched)", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const originalBody = block.body;
    const result = applyDone(block, FIXED_ISO);
    if ("markedDone" in result) {
      expect(result.markedDone.body).toBe(originalBody);
    }
  });

  it("unknown rawMeta keys survive byte-identical", () => {
    const withExtra = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: extra keys`,
      `action-id: extra-action`,
      `custom-field: my-value`,
      `another-key: 42`,
      ``,
      `Body.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(withExtra);
    const result = applyDone(block, FIXED_ISO);
    if ("markedDone" in result) {
      // Unknown keys must survive
      expect(result.markedDone.rawMeta).toContain("custom-field: my-value");
      expect(result.markedDone.rawMeta).toContain("another-key: 42");
    }
  });
});

describe("applyDone - idempotence", () => {
  it("returns alreadyDone on second apply with the original timestamp", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const first = applyDone(block, FIXED_ISO);
    if (!("markedDone" in first)) throw new Error("first apply should produce markedDone");

    const second = applyDone(first.markedDone, "2026-06-09T13:00:00Z");
    expect("alreadyDone" in second).toBe(true);
    if ("alreadyDone" in second) {
      expect(second.existingDoneAt).toBe(FIXED_ISO);
    }
  });

  it("does not modify rawMeta on second apply", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const first = applyDone(block, FIXED_ISO);
    if (!("markedDone" in first)) throw new Error("first apply should produce markedDone");

    const rawMetaAfterFirst = first.markedDone.rawMeta;
    applyDone(first.markedDone, "2026-06-09T13:00:00Z");
    // rawMeta unchanged - second apply is a no-op
    expect(first.markedDone.rawMeta).toBe(rawMetaAfterFirst);
  });
});

describe("applyDone - decoy: done: in body is NOT treated as done", () => {
  it("body containing 'done: 2026-01-01' is not mistaken for done state", () => {
    const withDecoy = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: decoy test`,
      `action-id: decoy-action`,
      ``,
      `Note: done: 2026-01-01 is in the body only and must not be treated as done.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(withDecoy);
    // Confirm no done in rawMeta (body text doesn't leak into rawMeta)
    expect(block.rawMeta).not.toContain("done:");
    const result = applyDone(block, FIXED_ISO);
    // Should not be alreadyDone - body decoy did not trigger the guard
    expect("alreadyDone" in result).toBe(false);
    if ("markedDone" in result) {
      expect(result.doneAt).toBe(FIXED_ISO);
    }
  });
});

describe("applyDone - serialize round-trip", () => {
  it("serialize(markedDone) contains done: in the rawMeta region", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDone(block, FIXED_ISO);
    if (!("markedDone" in result)) throw new Error("should produce markedDone");

    const serialized = serializeBlock(result.markedDone);
    // The done: line should appear in the serialized output (in the meta region)
    expect(serialized).toContain(`done: ${FIXED_ISO}`);
    // Body must survive byte-identical
    expect(serialized).toContain("Please review and confirm before implementation.");
  });

  it("re-parse of serialized block sees actionCard.done", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDone(block, FIXED_ISO);
    if (!("markedDone" in result)) throw new Error("should produce markedDone");

    const serialized = serializeBlock(result.markedDone);
    const reparsed = parseBlock(serialized);
    expect(reparsed.actionCard).toBeDefined();
    expect(reparsed.actionCard!.done).toBe(FIXED_ISO);
  });
});

describe("parse tolerance - hand-written 'done: true' (kink #6)", () => {
  const BOOL_DONE_RAW = [
    `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
    `action-id: TASK-438-spec-review`,
    `priority: high`,
    `done: true`,
    ``,
    `Hand-written boolean done - YAML decodes it to true, not a string.`,
    ``,
    `---`,
  ].join("\n");

  it("boolean true counts as done, with the block timestamp as doneAt", () => {
    const block = parseBlock(BOOL_DONE_RAW);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.done).toBe("2026-06-09T10:00:00Z");
  });

  it("'done: false' is NOT done", () => {
    const block = parseBlock(BOOL_DONE_RAW.replace("done: true", "done: false"));
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.done).toBeUndefined();
  });

  it("a string ISO still wins over the fallback", () => {
    const block = parseBlock(
      BOOL_DONE_RAW.replace("done: true", `done: "2026-06-09T11:30:00Z"`)
    );
    expect(block.actionCard!.done).toBe("2026-06-09T11:30:00Z");
  });
});
