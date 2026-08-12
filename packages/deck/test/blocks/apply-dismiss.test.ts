/**
 * Unit tests for applyDismiss and applyDoneNote (app/lib/blocks/answer.ts).
 *
 * Covers:
 * - applyDismiss: writes dismissed: and dismiss-reason: lines; idempotent;
 *   mutual exclusion both directions (done -> no-op; dismissed -> no-op);
 *   JSON-encoding of reason round-trips quotes/colons/newlines;
 *   decoy "dismissed:" in body ignored (rawMeta-only guard);
 *   bare dismiss emits replyBlock with body "Dismissed";
 *   dismiss with reason emits replyBlock with body = reason;
 *   dismiss-reason JSON round-trip.
 * - applyDoneNote: appends done-note: once; idempotent; requires done:.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { applyDone, applyDismiss, applyDoneNote } from "~/lib/blocks/answer.js";

const FIXED_ISO = "2026-06-09T12:00:00Z";

const ACTION_BLOCK_RAW = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
  `action-id: TASK-440-spec-review`,
  `priority: high`,
  ``,
  `Please review before implementation.`,
  ``,
  `---`,
].join("\n");

const DONE_BLOCK_RAW = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
  `action-id: TASK-440-done-action`,
  `done: 2026-06-09T11:00:00Z`,
  ``,
  `Already done body.`,
  ``,
  `---`,
].join("\n");

// ---------------------------------------------------------------------------
// applyDismiss - first application
// ---------------------------------------------------------------------------

describe("applyDismiss - first application", () => {
  it("returns dismissedBlock (not alreadyDismissed) on first apply", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, "not relevant now", FIXED_ISO);
    expect("alreadyDismissed" in result).toBe(false);
    expect("alreadyDone" in result).toBe(false);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock).toBeDefined();
      expect(result.dismissedAt).toBe(FIXED_ISO);
    }
  });

  it("appends 'dismissed: <ISO>' to rawMeta", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock.rawMeta).toContain(`dismissed: ${FIXED_ISO}`);
    }
  });

  it("appends 'dismiss-reason: <JSON>' when reason is provided", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const reason = "Not relevant anymore";
    const result = applyDismiss(block, reason, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock.rawMeta).toContain(
        `dismiss-reason: ${JSON.stringify(reason)}`
      );
    }
  });

  it("does NOT append dismiss-reason when reason is empty", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, "", FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock.rawMeta).not.toContain("dismiss-reason:");
    }
  });

  it("preserves existing rawMeta lines byte-identical (fence-bounded)", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock.rawMeta).toContain("action-id: TASK-440-spec-review");
      expect(result.dismissedBlock.rawMeta).toContain("priority: high");
    }
  });

  it("body is byte-identical (fence-bounded: only rawMeta touched)", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const originalBody = block.body;
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.dismissedBlock.body).toBe(originalBody);
    }
  });

  it("JSON-encoding of reason round-trips quotes and colons", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const reason = 'Has "quotes" and colons: here';
    const result = applyDismiss(block, reason, FIXED_ISO);
    if ("dismissedBlock" in result) {
      const serialized = serializeBlock(result.dismissedBlock);
      const reparsed = parseBlock(serialized);
      expect(reparsed.actionCard).toBeDefined();
      expect(reparsed.actionCard!.dismissReason).toBe(reason);
    }
  });

  it("JSON-encoding of reason round-trips newlines", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const reason = "Line 1\nLine 2";
    const result = applyDismiss(block, reason, FIXED_ISO);
    if ("dismissedBlock" in result) {
      const serialized = serializeBlock(result.dismissedBlock);
      const reparsed = parseBlock(serialized);
      expect(reparsed.actionCard!.dismissReason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// applyDismiss - reply block
// ---------------------------------------------------------------------------

describe("applyDismiss - reply block", () => {
  it("bare dismiss emits replyBlock with body 'Dismissed'", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.replyBlock.body).toBe("Dismissed");
      expect(result.replyBlock.rawMeta).toContain("dismissed-reply: true");
    }
  });

  it("dismiss with reason emits replyBlock with body = reason", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const reason = "Decided to skip for now";
    const result = applyDismiss(block, reason, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.replyBlock.body).toBe(reason);
      expect(result.replyBlock.rawMeta).toContain("dismissed-reply: true");
    }
  });

  it("replyBlock is from alex with sent status", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if ("dismissedBlock" in result) {
      expect(result.replyBlock.header.from).toBe("alex");
      expect(result.replyBlock.header.status).toBe("sent");
    }
  });
});

// ---------------------------------------------------------------------------
// applyDismiss - idempotency
// ---------------------------------------------------------------------------

describe("applyDismiss - idempotency", () => {
  it("returns alreadyDismissed on second apply", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const first = applyDismiss(block, "reason", FIXED_ISO);
    if (!("dismissedBlock" in first)) throw new Error("first apply should not be alreadyDismissed/alreadyDone");
    const second = applyDismiss(first.dismissedBlock, "another reason", "2026-06-09T13:00:00Z");
    expect("alreadyDismissed" in second).toBe(true);
    if ("alreadyDismissed" in second) {
      expect(second.existingDismissedAt).toBe(FIXED_ISO);
    }
  });

  it("does not modify rawMeta on second apply", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const first = applyDismiss(block, "reason", FIXED_ISO);
    if (!("dismissedBlock" in first)) throw new Error("first apply should not be alreadyDismissed");
    const rawMetaAfterFirst = first.dismissedBlock.rawMeta;
    applyDismiss(first.dismissedBlock, "another reason", "2026-06-09T13:00:00Z");
    expect(first.dismissedBlock.rawMeta).toBe(rawMetaAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// applyDismiss - mutual exclusion
// ---------------------------------------------------------------------------

describe("applyDismiss - mutual exclusion with done:", () => {
  it("returns alreadyDone when done: is present (cannot dismiss a done action)", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const result = applyDismiss(block, "some reason", FIXED_ISO);
    expect("alreadyDone" in result).toBe(true);
  });

  it("applyDone returns alreadyDismissed (honest shape) when dismissed: is present", () => {
    // First dismiss the block.
    const block = parseBlock(ACTION_BLOCK_RAW);
    const dismissResult = applyDismiss(block, undefined, FIXED_ISO);
    if (!("dismissedBlock" in dismissResult)) {
      throw new Error("first dismiss should succeed");
    }
    // Now try to mark done on the dismissed block. A dismissed action is NOT
    // done - the result must report alreadyDismissed with the dismissed
    // timestamp, never alreadyDone with a fake existingDoneAt (manager-review fix).
    const doneResult = applyDone(dismissResult.dismissedBlock, "2026-06-09T13:00:00Z");
    expect("alreadyDone" in doneResult).toBe(false);
    expect("alreadyDismissed" in doneResult).toBe(true);
    if ("alreadyDismissed" in doneResult) {
      expect(doneResult.existingDismissedAt).toBe(FIXED_ISO);
    }
  });
});

// ---------------------------------------------------------------------------
// applyDismiss - decoy: dismissed: in body is NOT treated as dismissed
// ---------------------------------------------------------------------------

describe("applyDismiss - decoy: dismissed: in body is NOT treated as dismissed", () => {
  it("body containing 'dismissed: 2026-01-01' is not mistaken for dismissed state", () => {
    const withDecoy = [
      `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: decoy dismiss test`,
      `action-id: decoy-dismiss-action`,
      ``,
      `Note: dismissed: 2026-01-01 is in the body only and must not be treated as dismissed.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(withDecoy);
    expect(block.rawMeta).not.toContain("dismissed:");
    const result = applyDismiss(block, undefined, FIXED_ISO);
    expect("alreadyDismissed" in result).toBe(false);
    expect("alreadyDone" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDismiss - serialize round-trip
// ---------------------------------------------------------------------------

describe("applyDismiss - serialize round-trip", () => {
  it("re-parse of serialized block sees actionCard.dismissed", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDismiss(block, undefined, FIXED_ISO);
    if (!("dismissedBlock" in result)) throw new Error("should not be already-state");
    const serialized = serializeBlock(result.dismissedBlock);
    const reparsed = parseBlock(serialized);
    expect(reparsed.actionCard).toBeDefined();
    expect(reparsed.actionCard!.dismissed).toBe(FIXED_ISO);
  });

  it("re-parse of serialized block with reason sees actionCard.dismissReason", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const reason = "Not needed anymore";
    const result = applyDismiss(block, reason, FIXED_ISO);
    if (!("dismissedBlock" in result)) throw new Error("should not be already-state");
    const serialized = serializeBlock(result.dismissedBlock);
    const reparsed = parseBlock(serialized);
    expect(reparsed.actionCard!.dismissReason).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// applyDoneNote - basic
// ---------------------------------------------------------------------------

describe("applyDoneNote - basic", () => {
  it("appends done-note: to rawMeta on a done block", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const note = "Handled via the integration";
    const result = applyDoneNote(block, note);
    if ("notDone" in result || "alreadyNoted" in result) throw new Error("should not be notDone/alreadyNoted");
    expect(result.notedBlock.rawMeta).toContain(`done-note: ${JSON.stringify(note)}`);
  });

  it("emits a replyBlock with rawMeta done-note: true", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const result = applyDoneNote(block, "My note");
    if ("notDone" in result || "alreadyNoted" in result) throw new Error("should not be notDone/alreadyNoted");
    expect(result.replyBlock.rawMeta).toContain("done-note: true");
    expect(result.replyBlock.body).toBe("My note");
  });

  it("replyBlock is from alex with sent status", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const result = applyDoneNote(block, "My note");
    if ("notDone" in result || "alreadyNoted" in result) throw new Error("should not be notDone/alreadyNoted");
    expect(result.replyBlock.header.from).toBe("alex");
    expect(result.replyBlock.header.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// applyDoneNote - requires done
// ---------------------------------------------------------------------------

describe("applyDoneNote - requires done:", () => {
  it("returns notDone when done: is absent", () => {
    const block = parseBlock(ACTION_BLOCK_RAW);
    const result = applyDoneNote(block, "some note");
    expect("notDone" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyDoneNote - idempotency
// ---------------------------------------------------------------------------

describe("applyDoneNote - idempotency", () => {
  it("returns alreadyNoted on second apply", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const first = applyDoneNote(block, "first note");
    if ("notDone" in first || "alreadyNoted" in first) throw new Error("first apply should succeed");
    const second = applyDoneNote(first.notedBlock, "second note");
    expect("alreadyNoted" in second).toBe(true);
  });

  it("does not modify rawMeta on second apply", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const first = applyDoneNote(block, "first note");
    if ("notDone" in first || "alreadyNoted" in first) throw new Error("first apply should succeed");
    const rawMetaAfterFirst = first.notedBlock.rawMeta;
    applyDoneNote(first.notedBlock, "second note");
    expect(first.notedBlock.rawMeta).toBe(rawMetaAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// applyDoneNote - serialize round-trip
// ---------------------------------------------------------------------------

describe("applyDoneNote - serialize round-trip", () => {
  it("re-parse of serialized block sees actionCard.doneNote", () => {
    const block = parseBlock(DONE_BLOCK_RAW);
    const note = 'Note with "quotes" and: colons';
    const result = applyDoneNote(block, note);
    if ("notDone" in result || "alreadyNoted" in result) throw new Error("should not be notDone/alreadyNoted");
    const serialized = serializeBlock(result.notedBlock);
    const reparsed = parseBlock(serialized);
    expect(reparsed.actionCard).toBeDefined();
    expect(reparsed.actionCard!.doneNote).toBe(note);
  });
});
