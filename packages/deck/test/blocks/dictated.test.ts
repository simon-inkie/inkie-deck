/**
 * Dictation provenance marker, so a reader can tell a reply was dictated.
 * A plain reply block written with rawMeta "dictated: true" must
 * round-trip serialize -> parse as a PLAIN block (no card/action
 * misclassification) with the meta line preserved, so both the Deck bubble
 * and agents reading raw markdown can see it.
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import type { MessageBlock } from "~/lib/blocks/model.js";

describe("dictated: true meta line", () => {
  const block: MessageBlock = {
    header: {
      timestamp: "2026-06-11T21:15:14Z",
      from: "alex",
      status: "sent",
      subject: "Re: deploy receipt",
    },
    body: "We also need to add a header to dictated messages.",
    rawMeta: "dictated: true",
    card: undefined,
  };

  it("round-trips as a plain block with the meta line preserved", () => {
    const reparsed = parseBlock(serializeBlock(block));
    expect(reparsed.card).toBeUndefined();
    expect(reparsed.actionCard).toBeUndefined();
    expect(reparsed.body).toBe(block.body);
    expect(/^dictated: true$/m.test(reparsed.rawMeta)).toBe(true);
  });

  it("a typed reply (empty rawMeta) carries no dictated line", () => {
    const typed: MessageBlock = { ...block, rawMeta: "" };
    const reparsed = parseBlock(serializeBlock(typed));
    expect(/^dictated: true$/m.test(reparsed.rawMeta)).toBe(false);
  });
});
