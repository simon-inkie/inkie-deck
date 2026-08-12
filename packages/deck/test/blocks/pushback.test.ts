/**
 * RED tests for applyPushBack (app/lib/blocks/answer.ts)
 * Verifies: push-back flip, distinct reply block, idempotency (CARD-03/CARD-04 contract).
 * Ref: T-02-01, T-02-02, T-02-04 (Tampering - push-back writeback + idempotency + round-trip).
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { applyPushBack, PUSHBACK_RESOLUTION, PUSHBACK_REPLY_MARKER } from "~/lib/blocks/answer.js";

/** Minimal valid card block for testing. */
const CARD_BLOCK = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-413-q1`,
  `blocking: true`,
  `options:`,
  `  - key: A`,
  `    label: "Hold spend at £45/day"`,
  `    detail: "Conservative. Preserves runway."`,
  `  - key: B`,
  `    label: "Push to £80/day"`,
  `    detail: "Faster learning."`,
  `lean: "B"`,
  ``,
  `**The problem:** Choose a spend level.`,
  ``,
  `---`,
].join("\n");

describe("applyPushBack - first application (push-back flip + distinct reply block)", () => {
  it("returns pushedBackOriginal and pushBackBlock on first apply", () => {
    const original = parseBlock(CARD_BLOCK);
    expect(original.card).toBeDefined();

    const result = applyPushBack(original);
    expect("alreadyResolved" in result).toBe(false);
    if (!("alreadyResolved" in result)) {
      expect(result.pushedBackOriginal).toBeDefined();
      expect(result.pushBackBlock).toBeDefined();
    }
  });

  it("pushedBackOriginal rawMeta contains 'answered: pushback'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushedBackOriginal.rawMeta).toContain(`answered: ${PUSHBACK_RESOLUTION}`);
    }
  });

  it("pushBackBlock rawMeta contains the push-back reply marker", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushBackBlock.rawMeta).toContain(PUSHBACK_REPLY_MARKER);
    }
  });

  it("pushBackBlock header has from: alex and status: sent", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushBackBlock.header.from).toBe("alex");
      expect(result.pushBackBlock.header.status).toBe("sent");
    }
  });

  it("pushBackBlock subject is 'Re: <original subject>'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushBackBlock.header.subject).toBe("Re: ad spend decision");
    }
  });

  it("pushedBackOriginal preserves lean and blocking (unknown fields untouched)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushedBackOriginal.rawMeta).toContain("lean:");
      expect(result.pushedBackOriginal.rawMeta).toContain("blocking:");
    }
  });

  it("pushBackBlock card is undefined (reply is not a card)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      expect(result.pushBackBlock.card).toBeUndefined();
    }
  });

  it("pushBackBlock body is ASCII-only (no em-dashes)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if (!("alreadyResolved" in result)) {
      // Body should be ASCII only - check for em-dash (U+2014) or en-dash (U+2013)
      expect(result.pushBackBlock.body).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("applyPushBack with a note includes the note in the body", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original, "Not now, revisit Monday.");
    if (!("alreadyResolved" in result)) {
      expect(result.pushBackBlock.body).toContain("Not now, revisit Monday.");
    }
  });

  it("PUSHBACK_RESOLUTION is an exported const (single source of truth)", () => {
    // The token should be a non-empty string
    expect(typeof PUSHBACK_RESOLUTION).toBe("string");
    expect(PUSHBACK_RESOLUTION.length).toBeGreaterThan(0);
  });

  it("PUSHBACK_REPLY_MARKER is an exported const (single source of truth)", () => {
    expect(typeof PUSHBACK_REPLY_MARKER).toBe("string");
    expect(PUSHBACK_REPLY_MARKER.length).toBeGreaterThan(0);
  });
});

describe("applyPushBack - idempotency: pushback-then-pushback (CARD-04)", () => {
  it("second applyPushBack returns alreadyResolved: true", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyPushBack(original);
    if ("alreadyResolved" in first) {
      throw new Error("Expected first apply to succeed");
    }

    const second = applyPushBack(first.pushedBackOriginal);
    expect("alreadyResolved" in second).toBe(true);
  });

  it("second applyPushBack returns the existing state string", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyPushBack(original);
    if ("alreadyResolved" in first) throw new Error("Expected first apply to succeed");

    const second = applyPushBack(first.pushedBackOriginal);
    if ("alreadyResolved" in second) {
      expect(second.existingState).toBe(PUSHBACK_RESOLUTION);
    }
  });

  it("second applyPushBack produces no pushBackBlock (no write)", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyPushBack(original);
    if ("alreadyResolved" in first) throw new Error("Expected first apply to succeed");

    const second = applyPushBack(first.pushedBackOriginal);
    expect("pushBackBlock" in second).toBe(false);
  });
});

describe("applyPushBack - idempotency: answered-then-pushback (CARD-04 mutual exclusion)", () => {
  const ANSWERED_BLOCK = [
    `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
    `decision-id: TASK-413-q1`,
    `blocking: true`,
    `options:`,
    `  - key: A`,
    `    label: "Hold spend at £45/day"`,
    `    detail: "Conservative. Preserves runway."`,
    `  - key: B`,
    `    label: "Push to £80/day"`,
    `    detail: "Faster learning."`,
    `lean: "B"`,
    `answered: B`,
    ``,
    `**The problem:** Choose a spend level.`,
    ``,
    `---`,
  ].join("\n");

  it("applyPushBack on an already-answered card returns alreadyResolved: true", () => {
    const answered = parseBlock(ANSWERED_BLOCK);
    const result = applyPushBack(answered);
    expect("alreadyResolved" in result).toBe(true);
  });

  it("applyPushBack on an answered card returns the existing answer state in existingState", () => {
    const answered = parseBlock(ANSWERED_BLOCK);
    const result = applyPushBack(answered);
    if ("alreadyResolved" in result) {
      expect(result.existingState).toBe("B");
    }
  });

  it("no pushBackBlock emitted when already answered", () => {
    const answered = parseBlock(ANSWERED_BLOCK);
    const result = applyPushBack(answered);
    expect("pushBackBlock" in result).toBe(false);
  });
});

describe("serialize-apply-twice stability (T-02-04)", () => {
  it("serializeBlock(pushedBackOriginal) still contains lean and blocking lines", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if ("alreadyResolved" in result) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.pushedBackOriginal);
    expect(serialized).toContain("lean:");
    expect(serialized).toContain("blocking:");
  });

  it("serializeBlock(pushedBackOriginal) contains answered: pushback", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyPushBack(original);
    if ("alreadyResolved" in result) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.pushedBackOriginal);
    expect(serialized).toContain(`answered: ${PUSHBACK_RESOLUTION}`);
  });

  it("apply-twice is idempotent: rawMeta has only one answered: line", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyPushBack(original);
    if ("alreadyResolved" in first) throw new Error("Expected first apply to succeed");

    // Second apply is a no-op; block has exactly one answered: line
    const meta = first.pushedBackOriginal.rawMeta;
    const answeredLines = meta.split("\n").filter(l => l.startsWith("answered:"));
    expect(answeredLines).toHaveLength(1);
  });

  it("serializeBlock stability after second no-op apply", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyPushBack(original);
    if ("alreadyResolved" in first) throw new Error("Expected first apply to succeed");

    const serializedOnce = serializeBlock(first.pushedBackOriginal);

    // Second apply is a no-op - serialize the same block again
    const second = applyPushBack(first.pushedBackOriginal);
    if ("alreadyResolved" in second) {
      const serializedTwice = serializeBlock(first.pushedBackOriginal);
      expect(serializedOnce).toBe(serializedTwice);
    }
  });
});
