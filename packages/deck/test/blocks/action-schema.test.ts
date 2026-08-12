/**
 * Unit tests for ActionSchema (app/lib/blocks/schema.ts) and action-card parsing
 * in parseBlock (app/lib/blocks/parse.ts).
 *
 * Covers:
 * - Full action-card block (all fields)
 * - Minimal action-card block (action-id only)
 * - Both decision-id and action-id present: decision wins (CARD-05 precedence + console.warn)
 * - Garbage/no action-id: plain bubble, no throw (CARD-05 never-throw contract)
 * - Done field round-trips via rawMeta
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect, vi } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { ActionSchema } from "~/lib/blocks/schema.js";

// ---------------------------------------------------------------------------
// ActionSchema unit tests
// ---------------------------------------------------------------------------

describe("ActionSchema - parse matrix", () => {
  it("succeeds with all fields (action-id, priority, ticket)", () => {
    const input = {
      "action-id": "TASK-438-spec-review",
      priority: "high",
      ticket: "https://linear.app/example-org/issue/TASK-438",
    };
    const result = ActionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["action-id"]).toBe("TASK-438-spec-review");
      expect(result.data.priority).toBe("high");
      expect(result.data.ticket).toBe("https://linear.app/example-org/issue/TASK-438");
    }
  });

  it("succeeds with only action-id (minimal)", () => {
    const input = { "action-id": "minimal-action" };
    const result = ActionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["action-id"]).toBe("minimal-action");
      expect(result.data.priority).toBeUndefined();
      expect(result.data.ticket).toBeUndefined();
    }
  });

  it("fails when action-id is missing", () => {
    const input = { priority: "high" };
    const result = ActionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("fails when action-id is empty string", () => {
    const input = { "action-id": "" };
    const result = ActionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseBlock with action cards
// ---------------------------------------------------------------------------

const ACTION_BLOCK = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review TASK-438 spec`,
  `action-id: TASK-438-spec-review`,
  `priority: high`,
  `ticket: https://linear.app/example-org/issue/TASK-438`,
  ``,
  `Please review the plan before implementation begins.`,
  ``,
  `---`,
].join("\n");

const MINIMAL_ACTION_BLOCK = [
  `## 2026-06-09T11:00:00Z - from: quill - status: sent - subject: do this thing`,
  `action-id: action-minimal`,
  ``,
  `No priority or ticket.`,
  ``,
  `---`,
].join("\n");

describe("parseBlock - action card parsing", () => {
  it("parses a full action card with all fields", () => {
    const block = parseBlock(ACTION_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.card).toBeUndefined();
    expect(block.actionCard!.actionId).toBe("TASK-438-spec-review");
    expect(block.actionCard!.priority).toBe("high");
    expect(block.actionCard!.ticket).toBe("https://linear.app/example-org/issue/TASK-438");
  });

  it("parses a minimal action card (action-id only)", () => {
    const block = parseBlock(MINIMAL_ACTION_BLOCK);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.actionId).toBe("action-minimal");
    // Absent priority normalises to "normal" (pinned vocab, Atlas TASK-438)
    expect(block.actionCard?.priority).toBe("normal");
    expect(block.actionCard!.ticket).toBeUndefined();
  });

  it("sets actionCard.done when rawMeta contains a done: line", () => {
    const withDone = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
      `action-id: done-action`,
      `done: 2026-06-09T11:00:00Z`,
      ``,
      `Body text.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(withDone);
    expect(block.actionCard).toBeDefined();
    expect(block.actionCard!.done).toBe("2026-06-09T11:00:00Z");
  });

  it("CARD-05: block with neither decision-id nor action-id is a plain bubble", () => {
    const plainBlock = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: just a message`,
      `priority: high`,
      ``,
      `Plain message with no card schema.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(plainBlock);
    expect(block.card).toBeUndefined();
    expect(block.actionCard).toBeUndefined();
  });

  it("CARD-05 precedence: both decision-id and action-id -> decision wins, console.warn fired", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bothIds = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: dual ids`,
      `decision-id: dec-1`,
      `action-id: act-1`,
      `options:`,
      `  - key: A`,
      `    label: Option A`,
      `    detail: Detail A`,
      ``,
      `Body.`,
      ``,
      `---`,
    ].join("\n");

    const block = parseBlock(bothIds);
    // Decision wins
    expect(block.card).toBeDefined();
    expect(block.card!.decisionId).toBe("dec-1");
    expect(block.actionCard).toBeUndefined();
    // console.warn was called
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("both decision-id and action-id")
    );
    warnSpy.mockRestore();
  });

  it("CARD-05: does not throw on garbage input", () => {
    const garbage = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: garbage`,
      `!!!: this is not valid yaml at all {{{`,
      ``,
      `Body.`,
      ``,
      `---`,
    ].join("\n");
    expect(() => parseBlock(garbage)).not.toThrow();
    const block = parseBlock(garbage);
    expect(block.card).toBeUndefined();
    expect(block.actionCard).toBeUndefined();
  });

  it("normalises an unknown priority to normal with a warn, never skipping the card (Atlas fold)", () => {
    const raw = [
      "## 2026-06-06T10:00:00Z - from: quill - status: sent - subject: Mistyped priority",
      "action-id: act-weird-priority",
      "priority: P1",
      "",
      "Do the thing.",
      "",
      "---",
    ].join("\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const block = parseBlock(raw);
      expect(block.actionCard).toBeDefined();
      expect(block.actionCard?.priority).toBe("normal");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown action priority"));
    } finally {
      warnSpy.mockRestore();
    }
  });

});
