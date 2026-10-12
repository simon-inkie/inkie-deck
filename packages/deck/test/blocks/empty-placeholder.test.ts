/**
 * Regression tests for the "clicking doesn't work" bug (empty placeholder values).
 *
 * Some agents author cards with pre-written EMPTY meta fields as a template:
 *   answered:
 *   custom-answer:
 * The apply* guards used to match those placeholder lines as "already
 * resolved" and no-op every tap, while parse correctly treated the empty
 * value as unanswered - so the card could never be resolved from the UI.
 *
 * Contract under test:
 * 1. An empty placeholder does NOT count as resolved (apply proceeds).
 * 2. The placeholder line is filled IN PLACE (no duplicate YAML key, which
 *    would poison the next parse of the block).
 * 3. The applied block round-trips: serialize -> parse shows the answer.
 * 4. Non-empty values still no-op.
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import {
  applyAnswer,
  applyCustomAnswer,
  applyPushBack,
  applyDone,
  applyDismiss,
  CUSTOM_ANSWER_RESOLUTION,
} from "~/lib/blocks/answer.js";

/** Card block in the placeholder-template shape. */
const PLACEHOLDER_CARD = [
  `## 2026-06-10T15:27:30Z - from: quill - status: read - subject: Decision with template placeholders`,
  `decision-id: PLACEHOLDER-Q1`,
  `options:`,
  `  - key: A`,
  `    label: "Merge it"`,
  `    detail: "The clean close."`,
  `  - key: B`,
  `    label: "Leave it"`,
  `    detail: "Status quo."`,
  `lean: A`,
  `answered: `,
  `custom-answer: `,
  ``,
  `The question body.`,
  ``,
  `---`,
].join("\n");

/** Action card with an empty done: placeholder. */
const PLACEHOLDER_ACTION = [
  `## 2026-06-10T16:00:00Z - from: quill - status: read - subject: do the thing`,
  `action-id: PLACEHOLDER-ACT-1`,
  `priority: high`,
  `done: `,
  `dismissed: `,
  ``,
  `Action body.`,
  ``,
  `---`,
].join("\n");

describe("empty answered: placeholder does not block resolution", () => {
  it("parse treats the placeholder card as unanswered", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    expect(block.card).toBeDefined();
    expect(block.card!.answered).toBeUndefined();
  });

  it("applyAnswer proceeds (no alreadyAnswered no-op)", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const result = applyAnswer(block, "A");
    expect("alreadyAnswered" in result).toBe(false);
  });

  it("applyAnswer fills the placeholder in place - exactly one answered line", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const result = applyAnswer(block, "A");
    if (!("answeredOriginal" in result)) throw new Error("unexpected no-op");
    const answeredLines = result.answeredOriginal.rawMeta
      .split("\n")
      .filter((l) => l.startsWith("answered:"));
    expect(answeredLines).toEqual(["answered: A"]);
  });

  it("applied block round-trips: serialize -> parse shows answered A", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const result = applyAnswer(block, "A");
    if (!("answeredOriginal" in result)) throw new Error("unexpected no-op");
    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    expect(reparsed.card?.answered).toBe("A");
  });

  it("applyCustomAnswer fills both placeholders in place (no duplicate keys)", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const result = applyCustomAnswer(block, "my own take: ship it");
    if (!("answeredOriginal" in result)) throw new Error("unexpected no-op");
    const meta = result.answeredOriginal.rawMeta;
    expect(meta.split("\n").filter((l) => l.startsWith("answered:"))).toEqual([
      `answered: ${CUSTOM_ANSWER_RESOLUTION}`,
    ]);
    expect(
      meta.split("\n").filter((l) => l.startsWith("custom-answer:"))
    ).toHaveLength(1);
    const reparsed = parseBlock(serializeBlock(result.answeredOriginal));
    expect(reparsed.card?.answered).toBe(CUSTOM_ANSWER_RESOLUTION);
    expect(reparsed.card?.customAnswer).toBe("my own take: ship it");
  });

  it("applyPushBack proceeds on a placeholder card", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const result = applyPushBack(block, "not yet");
    expect("alreadyResolved" in result).toBe(false);
  });

  it("CARD-04 unchanged: a real answered value still no-ops", () => {
    const block = parseBlock(PLACEHOLDER_CARD);
    const first = applyAnswer(block, "B");
    if (!("answeredOriginal" in first)) throw new Error("unexpected no-op");
    const second = applyAnswer(first.answeredOriginal, "A");
    expect("alreadyAnswered" in second).toBe(true);
    if ("alreadyAnswered" in second) {
      expect(second.existingAnswer).toBe("B");
    }
  });
});

describe("empty done:/dismissed: placeholders do not block action cards", () => {
  it("applyDone proceeds and fills the placeholder in place", () => {
    const block = parseBlock(PLACEHOLDER_ACTION);
    const result = applyDone(block, "2026-06-11T21:30:00Z");
    expect("alreadyDone" in result).toBe(false);
    expect("alreadyDismissed" in result).toBe(false);
    if ("markedDone" in result) {
      const doneLines = result.markedDone.rawMeta
        .split("\n")
        .filter((l) => l.startsWith("done:"));
      expect(doneLines).toEqual(["done: 2026-06-11T21:30:00Z"]);
    }
  });

  it("applyDismiss proceeds and fills the placeholder in place", () => {
    const block = parseBlock(PLACEHOLDER_ACTION);
    const result = applyDismiss(block, "overtaken by events", "2026-06-11T21:30:00Z");
    expect("alreadyDismissed" in result).toBe(false);
    expect("alreadyDone" in result).toBe(false);
    if ("dismissedBlock" in result) {
      const dismissedLines = result.dismissedBlock.rawMeta
        .split("\n")
        .filter((l) => l.startsWith("dismissed:"));
      expect(dismissedLines).toEqual(["dismissed: 2026-06-11T21:30:00Z"]);
    }
  });
});
