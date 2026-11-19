/**
 * action-intent.test.ts
 *
 * Unit tests for the zod intent schema exported from threads.$agent.tsx.
 * Tests run in node env with no DOM and no fs (pure schema validation only).
 *
 * Covers T-02-09: parse-don't-validate at the action boundary.
 * Valid payloads must parse; invalid or missing fields must be rejected.
 *
 * The schema is imported directly as a named export, keeping fs and the
 * route's server-side side-effects out of the test surface.
 */
import { describe, it, expect } from "vitest";
import { intentSchema } from "~/routes/threads.$agent";

// ---------------------------------------------------------------------------
// compose intent
// ---------------------------------------------------------------------------

describe("intentSchema - compose", () => {
  it("accepts a valid compose payload with a non-empty body", () => {
    const result = intentSchema.safeParse({ intent: "compose", body: "Hello" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe("compose");
      // Narrow to compose variant so TypeScript knows body exists
      if (result.data.intent === "compose") {
        expect(result.data.body).toBe("Hello");
      }
    }
  });

  it("trims whitespace from body and rejects a whitespace-only body", () => {
    const result = intentSchema.safeParse({ intent: "compose", body: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a compose payload with an empty body", () => {
    const result = intentSchema.safeParse({ intent: "compose", body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a compose payload missing the body field", () => {
    const result = intentSchema.safeParse({ intent: "compose" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// answer intent
// ---------------------------------------------------------------------------

describe("intentSchema - answer", () => {
  it("accepts a valid answer payload", () => {
    const result = intentSchema.safeParse({
      intent: "answer",
      decisionId: "TASK-413-q1",
      answerKey: "B",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.intent === "answer") {
      expect(result.data.decisionId).toBe("TASK-413-q1");
      expect(result.data.answerKey).toBe("B");
    }
  });

  it("rejects an answer payload missing decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "answer",
      answerKey: "B",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an answer payload with an empty decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "answer",
      decisionId: "",
      answerKey: "B",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an answer payload missing answerKey", () => {
    const result = intentSchema.safeParse({
      intent: "answer",
      decisionId: "TASK-413-q1",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushback intent
// ---------------------------------------------------------------------------

describe("intentSchema - pushback", () => {
  it("accepts a valid pushback payload with just decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "pushback",
      decisionId: "TASK-413-q1",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.intent === "pushback") {
      expect(result.data.decisionId).toBe("TASK-413-q1");
      expect(result.data.note).toBeUndefined();
    }
  });

  it("accepts a valid pushback payload with an optional note", () => {
    const result = intentSchema.safeParse({
      intent: "pushback",
      decisionId: "TASK-413-q1",
      note: "Need more data first",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.intent === "pushback") {
      expect(result.data.note).toBe("Need more data first");
    }
  });

  it("rejects a pushback payload missing decisionId", () => {
    const result = intentSchema.safeParse({ intent: "pushback" });
    expect(result.success).toBe(false);
  });

  it("rejects a pushback payload with an empty decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "pushback",
      decisionId: "   ",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// custom intent (option C user-authored answer)
// ---------------------------------------------------------------------------

describe("intentSchema - custom", () => {
  it("accepts a valid custom payload with decisionId and text", () => {
    const result = intentSchema.safeParse({
      intent: "custom",
      decisionId: "TASK-413-q1",
      text: "My own answer",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.intent === "custom") {
      expect(result.data.decisionId).toBe("TASK-413-q1");
      expect(result.data.text).toBe("My own answer");
    }
  });

  it("trims whitespace and rejects a whitespace-only text", () => {
    const result = intentSchema.safeParse({
      intent: "custom",
      decisionId: "TASK-413-q1",
      text: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a custom payload missing decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "custom",
      text: "My own answer",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a custom payload missing text", () => {
    const result = intentSchema.safeParse({
      intent: "custom",
      decisionId: "TASK-413-q1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a custom payload with an empty decisionId", () => {
    const result = intentSchema.safeParse({
      intent: "custom",
      decisionId: "",
      text: "My own answer",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thread C: dismissDecision / supersedeDecision / supersedeAction intents
// ---------------------------------------------------------------------------

describe("intentSchema - dismissDecision", () => {
  it("accepts a valid dismissDecision payload (reason optional)", () => {
    expect(
      intentSchema.safeParse({ intent: "dismissDecision", decisionId: "TASK-1-q1" }).success
    ).toBe(true);
    expect(
      intentSchema.safeParse({ intent: "dismissDecision", decisionId: "TASK-1-q1", reason: "stale" }).success
    ).toBe(true);
  });

  it("rejects a dismissDecision payload missing decisionId", () => {
    expect(intentSchema.safeParse({ intent: "dismissDecision" }).success).toBe(false);
    expect(intentSchema.safeParse({ intent: "dismissDecision", decisionId: "" }).success).toBe(false);
  });
});

describe("intentSchema - supersedeDecision", () => {
  it("accepts a valid supersedeDecision payload (note optional)", () => {
    expect(
      intentSchema.safeParse({ intent: "supersedeDecision", decisionId: "TASK-1-q1" }).success
    ).toBe(true);
    expect(
      intentSchema.safeParse({ intent: "supersedeDecision", decisionId: "TASK-1-q1", note: "replaced" }).success
    ).toBe(true);
  });

  it("rejects a supersedeDecision payload missing decisionId", () => {
    expect(intentSchema.safeParse({ intent: "supersedeDecision" }).success).toBe(false);
  });
});

describe("intentSchema - supersedeAction", () => {
  it("accepts a valid supersedeAction payload (note optional)", () => {
    expect(
      intentSchema.safeParse({ intent: "supersedeAction", actionId: "TASK-1-do" }).success
    ).toBe(true);
    expect(
      intentSchema.safeParse({ intent: "supersedeAction", actionId: "TASK-1-do", note: "replaced" }).success
    ).toBe(true);
  });

  it("rejects a supersedeAction payload missing actionId", () => {
    expect(intentSchema.safeParse({ intent: "supersedeAction" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unknown intent
// ---------------------------------------------------------------------------

describe("intentSchema - unknown intent", () => {
  it("rejects a payload with an unknown intent", () => {
    const result = intentSchema.safeParse({
      intent: "delete",
      decisionId: "TASK-413-q1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload with no intent at all", () => {
    const result = intentSchema.safeParse({ body: "hello" });
    expect(result.success).toBe(false);
  });
});
