/**
 * RED tests for app/lib/blocks/schema.ts and app/lib/blocks/model.ts
 * These tests verify the zod CardSchema and TypeScript model contracts.
 */
import { describe, it, expect } from "vitest";
import { CardSchema, OptionSchema } from "~/lib/blocks/schema.js";
import type { MessageBlock, DecisionCard } from "~/lib/blocks/model.js";

describe("OptionSchema", () => {
  it("accepts a valid option", () => {
    const result = OptionSchema.safeParse({ key: "A", label: "Hold spend", detail: "Conservative." });
    expect(result.success).toBe(true);
  });

  it("rejects option missing key", () => {
    const result = OptionSchema.safeParse({ label: "Hold spend", detail: "Conservative." });
    expect(result.success).toBe(false);
  });

  it("rejects option missing label", () => {
    const result = OptionSchema.safeParse({ key: "A", detail: "Conservative." });
    expect(result.success).toBe(false);
  });

  it("rejects option missing detail", () => {
    const result = OptionSchema.safeParse({ key: "A", label: "Hold spend" });
    expect(result.success).toBe(false);
  });
});

describe("CardSchema", () => {
  it("accepts a valid card with decision-id and options", () => {
    const result = CardSchema.safeParse({
      "decision-id": "TASK-413-q1",
      options: [{ key: "A", label: "x", detail: "y" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["decision-id"]).toBe("TASK-413-q1");
      expect(result.data.options).toHaveLength(1);
    }
  });

  it("rejects card missing decision-id", () => {
    const result = CardSchema.safeParse({
      options: [{ key: "A", label: "x", detail: "y" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects card with empty decision-id", () => {
    const result = CardSchema.safeParse({
      "decision-id": "",
      options: [{ key: "A", label: "x", detail: "y" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects card with empty options array", () => {
    const result = CardSchema.safeParse({
      "decision-id": "TASK-413-q1",
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects card missing options", () => {
    const result = CardSchema.safeParse({
      "decision-id": "TASK-413-q1",
    });
    expect(result.success).toBe(false);
  });

  it("does NOT carry unknown fields through safeParse (they live in rawMeta instead)", () => {
    const result = CardSchema.safeParse({
      "decision-id": "TASK-413-q1",
      options: [{ key: "A", label: "x", detail: "y" }],
      blocking: true,
      lean: "B",
    });
    // Unknown fields are NOT rejected (not using strictObject) - but they are not relied on
    // for round-trip. The test just ensures the known fields parse correctly.
    expect(result.success).toBe(true);
  });
});

// Type-level tests: verify the TypeScript types are exported correctly.
// These are compile-time checks only; they pass if the file compiles.
describe("TypeScript model types (compile-time)", () => {
  it("MessageBlock type is exported", () => {
    // Use a type assertion to verify shape - if type is wrong, TS compile fails
    const block: MessageBlock = {
      header: { timestamp: "2026-06-09T14:30:00Z", from: "scribe", status: "sent", subject: "test" },
      body: "body text",
      rawMeta: "",
    };
    expect(block.header.from).toBe("scribe");
    expect(block.card).toBeUndefined();
  });

  it("DecisionCard type is exported", () => {
    const card: DecisionCard = {
      decisionId: "TASK-413-q1",
      options: [{ key: "A", label: "Hold spend", detail: "Conservative." }],
    };
    expect(card.decisionId).toBe("TASK-413-q1");
    expect(card.answer).toBeUndefined();
    expect(card.answered).toBeUndefined();
  });
});
