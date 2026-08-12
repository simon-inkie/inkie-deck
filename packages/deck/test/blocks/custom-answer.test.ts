/**
 * custom-answer.test.ts - Tests for applyCustomAnswer (MC #2: option C)
 *
 * Verifies:
 * - Backbone round-trip for the C-from-user path (apply -> serialize -> re-parse)
 * - customAnswer and answered === "C" survive the round-trip
 * - Text with a colon and a quote round-trips cleanly
 * - Idempotency: already-answered card is a no-op
 * - Mutual exclusion with applyAnswer (answered-then-custom is a no-op)
 * - Reply block shape (from: alex, status: sent, answer: C in rawMeta)
 * - No em-dashes anywhere (FND-05)
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { applyCustomAnswer } from "~/lib/blocks/answer.js";

/** Minimal valid card block for testing. */
const CARD_BLOCK = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-413-q1`,
  `blocking: true`,
  `options:`,
  `  - key: A`,
  `    label: "Hold spend at 45/day"`,
  `    detail: "Conservative. Preserves runway."`,
  `  - key: B`,
  `    label: "Push to 80/day"`,
  `    detail: "Faster learning."`,
  `lean: "B"`,
  ``,
  `**The problem:** Choose a spend level.`,
  ``,
  `---`,
].join("\n");

// ---------------------------------------------------------------------------
// First application (basic shape)
// ---------------------------------------------------------------------------

describe("applyCustomAnswer - first application", () => {
  it("returns answeredOriginal and replyBlock on first apply", () => {
    const original = parseBlock(CARD_BLOCK);
    expect(original.card).toBeDefined();

    const result = applyCustomAnswer(original, "Do neither, try option C");
    expect("alreadyAnswered" in result).toBe(false);
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal).toBeDefined();
      expect(result.replyBlock).toBeDefined();
    }
  });

  it("answered original rawMeta contains 'answered: C'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("answered: C");
    }
  });

  it("answered original rawMeta contains 'custom-answer:' line", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("custom-answer:");
    }
  });

  it("reply block rawMeta contains 'answer: C'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.rawMeta).toBe("answer: C");
    }
  });

  it("reply block body is the user-authored text", () => {
    const original = parseBlock(CARD_BLOCK);
    const text = "My custom answer text";
    const result = applyCustomAnswer(original, text);
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.body).toBe(text);
    }
  });

  it("reply block header has from: alex and status: sent", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.header.from).toBe("alex");
      expect(result.replyBlock.header.status).toBe("sent");
    }
  });

  it("reply block subject is 'Re: <original subject>'", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.header.subject).toBe("Re: ad spend decision");
    }
  });

  it("reply block card is undefined (reply is not a card)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.card).toBeUndefined();
    }
  });

  it("unknown fields (lean, blocking) are preserved in answeredOriginal rawMeta", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("lean:");
      expect(result.answeredOriginal.rawMeta).toContain("blocking:");
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip: apply -> serialize -> re-parse
// ---------------------------------------------------------------------------

describe("applyCustomAnswer - round-trip (apply, serialize, re-parse)", () => {
  it("re-parsed card has answered === 'C' after round-trip", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My own proposal");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.answered).toBe("C");
  });

  it("re-parsed card has customAnswer matching the original text", () => {
    const original = parseBlock(CARD_BLOCK);
    const text = "My own proposal";
    const result = applyCustomAnswer(original, text);
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.customAnswer).toBe(text);
  });

  it("text with a colon survives the round-trip", () => {
    const original = parseBlock(CARD_BLOCK);
    const text = "Option C: reduce to 30/day and revisit next week";
    const result = applyCustomAnswer(original, text);
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.customAnswer).toBe(text);
  });

  it("text with a double-quote survives the round-trip", () => {
    const original = parseBlock(CARD_BLOCK);
    const text = `Let's go with "option C" my way`;
    const result = applyCustomAnswer(original, text);
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.customAnswer).toBe(text);
  });

  it("text with both a colon and a quote survives the round-trip", () => {
    const original = parseBlock(CARD_BLOCK);
    const text = `Decision: use "C strategy" instead`;
    const result = applyCustomAnswer(original, text);
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.customAnswer).toBe(text);
  });

  it("re-parsed card still has the original options after round-trip", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.options).toHaveLength(2);
  });

  it("re-serializing the re-parsed block is stable (parse -> serialize -> parse -> serialize)", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serializedOnce = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serializedOnce);
    const serializedTwice = serializeBlock(reparsed);
    expect(serializedTwice).toBe(serializedOnce);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (CARD-04)
// ---------------------------------------------------------------------------

describe("applyCustomAnswer - idempotency (CARD-04)", () => {
  it("second applyCustomAnswer on already-answered card returns alreadyAnswered: true", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const second = applyCustomAnswer(first.answeredOriginal, "A different text");
    expect("alreadyAnswered" in second).toBe(true);
  });

  it("second applyCustomAnswer returns existingAnswer === 'C'", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const second = applyCustomAnswer(first.answeredOriginal, "A different text");
    if ("alreadyAnswered" in second) {
      expect(second.existingAnswer).toBe("C");
    }
  });

  it("second apply produces no replyBlock (no write)", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const second = applyCustomAnswer(first.answeredOriginal, "A different text");
    expect("replyBlock" in second).toBe(false);
  });

  it("rawMeta has only one answered: line after apply", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const meta = result.answeredOriginal.rawMeta;
    const answeredLines = meta.split("\n").filter(l => l.startsWith("answered:"));
    expect(answeredLines).toHaveLength(1);
  });

  it("rawMeta has only one custom-answer: line after apply", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const meta = result.answeredOriginal.rawMeta;
    const customLines = meta.split("\n").filter(l => l.startsWith("custom-answer:"));
    expect(customLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusion: already answered via applyAnswer -> customAnswer is no-op
// ---------------------------------------------------------------------------

describe("applyCustomAnswer - mutual exclusion with existing answered: line", () => {
  const ALREADY_ANSWERED_BLOCK = [
    `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
    `decision-id: TASK-413-q1`,
    `options:`,
    `  - key: A`,
    `    label: "Hold spend at 45/day"`,
    `    detail: "Conservative."`,
    `  - key: B`,
    `    label: "Push to 80/day"`,
    `    detail: "Faster learning."`,
    `answered: B`,
    ``,
    `**The problem:** Choose a spend level.`,
    ``,
    `---`,
  ].join("\n");

  it("applyCustomAnswer on an already-answered-B card returns alreadyAnswered: true", () => {
    const block = parseBlock(ALREADY_ANSWERED_BLOCK);
    const result = applyCustomAnswer(block, "My custom answer");
    expect("alreadyAnswered" in result).toBe(true);
  });

  it("applyCustomAnswer on already-answered-B returns existingAnswer === 'B'", () => {
    const block = parseBlock(ALREADY_ANSWERED_BLOCK);
    const result = applyCustomAnswer(block, "My custom answer");
    if ("alreadyAnswered" in result) {
      expect(result.existingAnswer).toBe("B");
    }
  });

  it("no replyBlock emitted when already answered", () => {
    const block = parseBlock(ALREADY_ANSWERED_BLOCK);
    const result = applyCustomAnswer(block, "My custom answer");
    expect("replyBlock" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No em-dashes (FND-05)
// ---------------------------------------------------------------------------

describe("applyCustomAnswer - no em-dashes (FND-05)", () => {
  it("reply block body does not contain em-dashes or en-dashes", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "Plain text answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.body).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("answeredOriginal rawMeta does not contain em-dashes or en-dashes", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "Plain text answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
