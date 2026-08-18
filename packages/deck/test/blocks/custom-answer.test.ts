/**
 * custom-answer.test.ts - Tests for applyCustomAnswer (MC #2: option C)
 *
 * Verifies:
 * - Backbone round-trip for the C-from-user path (apply -> serialize -> re-parse)
 * - the written resolution reads back as a custom answer, not as a tap on option C
 * - Text with a colon and a quote round-trips cleanly
 * - Idempotency: already-answered card is a no-op
 * - Mutual exclusion with applyAnswer (answered-then-custom is a no-op)
 * - Reply block shape (from: alex, status: sent, answer: custom in rawMeta)
 * - No em-dashes anywhere (FND-05)
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import {
  applyAnswer,
  applyCustomAnswer,
  PUSHBACK_RESOLUTION,
  isCustomAnswer,
  CUSTOM_ANSWER_RESOLUTION,
} from "~/lib/blocks/answer.js";

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

  it("answered original rawMeta records the non-letter custom sentinel", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain(`answered: ${CUSTOM_ANSWER_RESOLUTION}`);
    }
  });

  it("answered original rawMeta contains 'custom-answer:' line", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.answeredOriginal.rawMeta).toContain("custom-answer:");
    }
  });

  it("reply block rawMeta carries the custom sentinel", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My custom answer");
    if ("answeredOriginal" in result) {
      expect(result.replyBlock.rawMeta).toBe(`answer: ${CUSTOM_ANSWER_RESOLUTION}`);
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
  it("round-trips as a custom answer, and NOT as a tap on option C", () => {
    const original = parseBlock(CARD_BLOCK);
    const result = applyCustomAnswer(original, "My own proposal");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const serialized = serializeBlock(result.answeredOriginal);
    const reparsed = parseBlock(serialized);
    expect(reparsed.card?.answered).toBe(CUSTOM_ANSWER_RESOLUTION);
    expect(reparsed.card?.answered).not.toBe("C");
    expect(isCustomAnswer(reparsed.card!)).toBe(true);
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

  it("the existing answer reported by the second apply is the custom sentinel", () => {
    const original = parseBlock(CARD_BLOCK);
    const first = applyCustomAnswer(original, "My custom answer");
    if (!("answeredOriginal" in first)) throw new Error("Expected first apply to succeed");

    const second = applyCustomAnswer(first.answeredOriginal, "A different text");
    if ("alreadyAnswered" in second) {
      expect(second.existingAnswer).toBe(CUSTOM_ANSWER_RESOLUTION);
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

// ---------------------------------------------------------------------------
// The option-C collision, both directions
// ---------------------------------------------------------------------------

/**
 * The sentinel used to be the letter "C", which is a REAL option key the
 * moment a card offers three or more options. That merged two different
 * events into one recorded value, and the damage ran both ways: a written
 * answer was indistinguishable from a tap on C, and a genuine tap on C was
 * read as a custom answer with no text to show - so the record rendered with
 * no option chosen at all.
 *
 * The reader is the load-bearing half. Nothing rewrites what is already on
 * disk, so the legacy form has to keep reading as custom while a historical
 * tap on C keeps reading as a tap. The custom-answer: field is what separates
 * them: a tap never writes one.
 */
const THREE_OPTION_CARD = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-413-q3`,
  `options:`,
  `  - key: A`,
  `    label: "Hold spend at 45/day"`,
  `    detail: "Conservative."`,
  `  - key: B`,
  `    label: "Push to 80/day"`,
  `    detail: "Faster learning."`,
  `  - key: C`,
  `    label: "Pause the campaign"`,
  `    detail: "Stop and think."`,
  ``,
  `**The problem:** Choose a spend level.`,
  ``,
  `---`,
].join("\n");

/** Build a card block already carrying the given meta lines. */
function cardWith(...metaLines: string[]): string {
  const lines = THREE_OPTION_CARD.split("\n");
  const bodyStart = lines.indexOf("");
  return [
    ...lines.slice(0, bodyStart),
    ...metaLines,
    ...lines.slice(bodyStart),
  ].join("\n");
}

describe("custom answer vs a real option C (three-option card)", () => {
  it("a written answer does not land on any of the card's own option keys", () => {
    const original = parseBlock(THREE_OPTION_CARD);
    const result = applyCustomAnswer(original, "Halve it and revisit Friday");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    const keys = reparsed.card!.options.map((o) => o.key);
    expect(keys).toContain("C");
    expect(keys).not.toContain(reparsed.card!.answered);
  });

  it("a tap on option C is not read as a custom answer", () => {
    const block = parseBlock(THREE_OPTION_CARD);
    const result = applyAnswer(block, "C");
    if (!("answeredOriginal" in result)) throw new Error("Expected the tap to apply");

    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    expect(reparsed.card?.answered).toBe("C");
    expect(isCustomAnswer(reparsed.card!)).toBe(false);
  });

  it("a tap on option A is not read as a custom answer", () => {
    const reparsed = parseBlock(cardWith("answered: A"));
    expect(isCustomAnswer(reparsed.card!)).toBe(false);
  });

  it("a pushed-back card is not read as a custom answer", () => {
    const reparsed = parseBlock(cardWith(`answered: ${PUSHBACK_RESOLUTION}`));
    expect(isCustomAnswer(reparsed.card!)).toBe(false);
  });

  it("an unanswered card is not read as a custom answer", () => {
    const reparsed = parseBlock(THREE_OPTION_CARD);
    expect(isCustomAnswer(reparsed.card!)).toBe(false);
  });
});

describe("custom answer - records written before the sentinel changed", () => {
  /** A card the old code custom-answered: the letter C plus the user's text. */
  const LEGACY_CUSTOM = cardWith(
    `answered: C`,
    `custom-answer: "Halve it and revisit Friday"`,
  );

  /** The same letter with no text: a genuine historical tap on option C. */
  const HISTORICAL_TAP = cardWith(`answered: C`);

  it("a legacy custom answer still reads as a custom answer", () => {
    const block = parseBlock(LEGACY_CUSTOM);
    expect(block.card?.answered).toBe("C");
    expect(isCustomAnswer(block.card!)).toBe(true);
  });

  it("a legacy custom answer still surfaces its text", () => {
    const block = parseBlock(LEGACY_CUSTOM);
    expect(block.card?.customAnswer).toBe("Halve it and revisit Friday");
  });

  it("a historical tap on option C still reads as a tap", () => {
    const block = parseBlock(HISTORICAL_TAP);
    expect(isCustomAnswer(block.card!)).toBe(false);
  });

  it("an EMPTY custom-answer: line is not evidence of a custom answer", () => {
    // parse treats an empty value as absent, so the legacy arm must not fire
    // on a template placeholder left beside a real tap on C.
    const block = parseBlock(cardWith(`answered: C`, `custom-answer: `));
    expect(block.card?.customAnswer).toBeUndefined();
    expect(isCustomAnswer(block.card!)).toBe(false);
  });

  it("a card written since the fix reads as a custom answer", () => {
    const block = parseBlock(
      cardWith(
        `answered: ${CUSTOM_ANSWER_RESOLUTION}`,
        `custom-answer: "Halve it and revisit Friday"`,
      ),
    );
    expect(isCustomAnswer(block.card!)).toBe(true);
  });

  it("both forms are still terminal: a legacy record cannot be re-answered", () => {
    const block = parseBlock(LEGACY_CUSTOM);
    const result = applyAnswer(block, "A");
    expect("alreadyAnswered" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The sentinel is safe by CONSTRUCTION, not by convention
// ---------------------------------------------------------------------------

/**
 * Moving off the letter "C" only made the collision UNLIKELY, not impossible.
 * Option keys are not constrained to letters: the parser accepts any non-empty
 * string, so a card author can key a real option `custom` and a tap on it
 * records exactly the marker a written answer records.
 *
 * So the marker alone cannot be the test. isCustomAnswer requires the
 * custom-answer TEXT as well, which a tap never writes - and that is what
 * turns "cannot collide with an option key" from a convention the next card
 * author might break into a property of the reader.
 */
const SENTINEL_KEYED_CARD = [
  `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: bespoke or off-the-shelf`,
  `decision-id: TASK-413-q4`,
  `options:`,
  `  - key: A`,
  `    label: "Take the standard package"`,
  `    detail: "Ships Monday."`,
  `  - key: ${CUSTOM_ANSWER_RESOLUTION}`,
  `    label: "Build a bespoke one"`,
  `    detail: "A real option someone keyed with the sentinel's spelling."`,
  ``,
  `**The problem:** Standard or bespoke?`,
  ``,
  `---`,
].join("\n");

describe("custom answer vs an option someone keyed with the sentinel", () => {
  it("a tap on an option keyed 'custom' is NOT read as a written answer", () => {
    const block = parseBlock(SENTINEL_KEYED_CARD);
    const result = applyAnswer(block, CUSTOM_ANSWER_RESOLUTION);
    if (!("answeredOriginal" in result)) throw new Error("Expected the tap to apply");

    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    // The tap recorded the sentinel's own spelling...
    expect(reparsed.card?.answered).toBe(CUSTOM_ANSWER_RESOLUTION);
    expect(reparsed.card?.options.map((o) => o.key)).toContain(CUSTOM_ANSWER_RESOLUTION);
    // ...and it still reads as a tap, because no text came with it.
    expect(reparsed.card?.customAnswer).toBeUndefined();
    expect(isCustomAnswer(reparsed.card!)).toBe(false);
  });

  it("the marker alone is never enough, whatever the card's options are", () => {
    expect(isCustomAnswer({ answered: CUSTOM_ANSWER_RESOLUTION })).toBe(false);
  });

  it("a written answer on the same card still reads as written", () => {
    // The other direction: the text is present, so the same marker means what
    // it is supposed to mean. Without this the test above is satisfied by a
    // reader that simply never says yes.
    const original = parseBlock(SENTINEL_KEYED_CARD);
    const result = applyCustomAnswer(original, "Bespoke, but reuse the standard billing");
    if (!("answeredOriginal" in result)) throw new Error("Expected first apply to succeed");

    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    expect(isCustomAnswer(reparsed.card!)).toBe(true);
  });

  it("orphaned text with no marker is not a written answer either", () => {
    // Both halves are load-bearing, so pin the missing-marker direction too.
    expect(isCustomAnswer({ customAnswer: "orphaned text" })).toBe(false);
    expect(isCustomAnswer({})).toBe(false);
  });

  it("the sentinel is not a single letter, so it cannot collide by accident", () => {
    // Guards the CHOICE rather than today's value: option keys are single
    // letters by convention, so any multi-character sentinel avoids the
    // accidental collision. Changing this back to a letter fails here.
    expect(CUSTOM_ANSWER_RESOLUTION).not.toMatch(/^[A-Z]$/);
  });
});
