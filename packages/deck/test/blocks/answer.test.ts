/**
 * RED tests for app/lib/blocks/answer.ts
 * Verifies: answered-flip, structured reply block, idempotency.
 * Ref: T-01-05 (Tampering - double-answer / conflicting answer writeback)
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { applyAnswer } from "~/lib/blocks/answer.js";

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

describe("applyAnswer - first application (answered flip + reply block)", () => {
  it("returns answeredOriginal and replyBlock on first apply", () => {
    const original = parseBlock(CARD_BLOCK);
    expect(original.card).toBeDefined();

    const result = applyAnswer(original, "B");
    expect("alreadyAnswered" in result).toBe(false);
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal).toBeDefined();
      expect(result.replyBlock).toBeDefined();
    }
  });

  it("answered original rawMeta contains 'answered: B'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyAnswer(original, "B");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("answered: B");
    }
  });

  it("reply block rawMeta contains 'answer: B'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyAnswer(original, "B");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.rawMeta).toContain("answer: B");
    }
  });

  it("reply block header has from: alex and status: sent", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyAnswer(original, "B");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.header.from).toBe("alex");
      expect(result.replyBlock.header.status).toBe("sent");
    }
  });

  it("answeredOriginal preserves lean and blocking (unknown fields untouched)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyAnswer(original, "B");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("lean:");
      expect(result.answeredOriginal.rawMeta).toContain("blocking:");
    }
  });

  it("answeredOriginal rawMeta does NOT contain 'answer:' (only 'answered:')", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyAnswer(original, "B");
    if ("answeredOriginal" in result) {
      // The original should have 'answered: B' but NOT an extra 'answer: B' line
      const meta = result.answeredOriginal.rawMeta;
      const answerLines = meta.split("\n").filter(l => l.startsWith("answer:"));
      expect(answerLines).toHaveLength(0);
    }
  });
});

describe("applyAnswer - idempotency (CARD-04)", () => {
  it("second applyAnswer returns alreadyAnswered:true", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) {
      throw new Error("Expected first apply to succeed");
    }

    // Apply again to the already-answered block
    const second = applyAnswer(first.answeredOriginal, "B");
    expect("alreadyAnswered" in second).toBe(true);
  });

  it("second applyAnswer returns the existing answer", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const second = applyAnswer(first.answeredOriginal, "B");
    if ("alreadyAnswered" in second) {
      expect(second.existingAnswer).toBe("B");
    }
  });

  it("second applyAnswer with a different key still returns alreadyAnswered:true", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    // Try to apply with a different key - must still be idempotent
    const second = applyAnswer(first.answeredOriginal, "A");
    expect("alreadyAnswered" in second).toBe(true);
  });

  it("no second answer: block after double apply", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    // Second apply is a no-op, no new replyBlock
    const second = applyAnswer(first.answeredOriginal, "B");
    expect("replyBlock" in second).toBe(false);
  });
});

describe("serialize-apply-twice stability", () => {
  it("serializeBlock(applyAnswer(x, k).answeredOriginal) is stable after second apply", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const serializedOnce = serializeBlock(first.answeredOriginal);

    // Second apply - no-op
    const second = applyAnswer(first.answeredOriginal, "B");
    if ("alreadyAnswered" in second) {
      // The original block should still serialize to the same thing
      const serializedTwice = serializeBlock(first.answeredOriginal);
      expect(serializedOnce).toBe(serializedTwice);
    }
  });

  it("only one answered: line in rawMeta after applying", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyAnswer(original, "B");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const meta = first.answeredOriginal.rawMeta;
    const answeredLines = meta.split("\n").filter(l => l.startsWith("answered:"));
    expect(answeredLines).toHaveLength(1);
  });
});
