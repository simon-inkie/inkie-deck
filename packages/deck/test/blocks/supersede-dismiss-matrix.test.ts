/**
 * Thread C mutual-exclusion matrix (app/lib/blocks/answer.ts + parse.ts).
 *
 * Two new terminal states: dismissed (decisions - actions already had it) and
 * superseded (both card types). Every terminal state must be checked against
 * every OTHER terminal state for its card type, both directions. This file
 * enumerates the whole matrix explicitly - no combination skipped because it
 * "obviously" works.
 *
 * Decision terminal states: answered (incl. pushback), dismissed, superseded.
 * Action terminal states:   done, dismissed, superseded.
 *
 * Also covers: parse + serialize round-trip for the new fields on both card
 * types, JSON round-trip of reason/note, decoy body values ignored.
 *
 * ASCII only - no em-dashes per FND-05.
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
  applyDismissDecision,
  applySupersedeAction,
  applySupersedeDecision,
} from "~/lib/blocks/answer.js";

const T1 = "2026-06-09T12:00:00Z";
const T2 = "2026-06-09T13:00:00Z";

// --- Fixtures ---------------------------------------------------------------

const DECISION_RAW = [
  `## 2026-06-09T10:00:00Z - from: scribe - status: sent - subject: pick a plan`,
  `decision-id: TASK-999-plan`,
  `blocking: true`,
  `options:`,
  `  - key: A`,
  `    label: "Ship it"`,
  `    detail: "Go now."`,
  `  - key: B`,
  `    label: "Wait"`,
  `    detail: "Hold."`,
  `lean: "A"`,
  ``,
  `**Which plan?**`,
  ``,
  `---`,
].join("\n");

const ACTION_RAW = [
  `## 2026-06-09T10:00:00Z - from: quill - status: sent - subject: review spec`,
  `action-id: TASK-999-review`,
  `priority: high`,
  ``,
  `Please review before implementation.`,
  ``,
  `---`,
].join("\n");

/** A decision block already dismissed (via applyDismissDecision). */
function dismissedDecision() {
  const r = applyDismissDecision(parseBlock(DECISION_RAW), "stale", T1);
  if (!("dismissedBlock" in r)) throw new Error("setup: dismiss should succeed");
  return r.dismissedBlock;
}

/** A decision block already superseded. */
function supersededDecision() {
  const r = applySupersedeDecision(parseBlock(DECISION_RAW), "replaced", T1);
  if (!("supersededBlock" in r)) throw new Error("setup: supersede should succeed");
  return r.supersededBlock;
}

/** A decision block already answered. */
function answeredDecision() {
  const r = applyAnswer(parseBlock(DECISION_RAW), "A");
  if (!("answeredOriginal" in r)) throw new Error("setup: answer should succeed");
  return r.answeredOriginal;
}

/** An action block already dismissed. */
function dismissedAction() {
  const r = applyDismiss(parseBlock(ACTION_RAW), "not now", T1);
  if (!("dismissedBlock" in r)) throw new Error("setup: dismiss should succeed");
  return r.dismissedBlock;
}

/** An action block already superseded. */
function supersededAction() {
  const r = applySupersedeAction(parseBlock(ACTION_RAW), "replaced", T1);
  if (!("supersededBlock" in r)) throw new Error("setup: supersede should succeed");
  return r.supersededBlock;
}

/** An action block already done. */
function doneAction() {
  const r = applyDone(parseBlock(ACTION_RAW), T1);
  if (!("markedDone" in r)) throw new Error("setup: done should succeed");
  return r.markedDone;
}

// ===========================================================================
// applyDismissDecision - first application + write shape
// ===========================================================================

describe("applyDismissDecision - first application", () => {
  it("writes dismissed: <ISO> and returns dismissedBlock", () => {
    const r = applyDismissDecision(parseBlock(DECISION_RAW), undefined, T1);
    expect("dismissedBlock" in r).toBe(true);
    if ("dismissedBlock" in r) {
      expect(r.dismissedAt).toBe(T1);
      expect(r.dismissedBlock.rawMeta).toContain(`dismissed: ${T1}`);
    }
  });

  it("writes dismiss-reason: <JSON> when a reason is given, omits when empty", () => {
    const withReason = applyDismissDecision(parseBlock(DECISION_RAW), "no longer relevant", T1);
    if ("dismissedBlock" in withReason) {
      expect(withReason.dismissedBlock.rawMeta).toContain(
        `dismiss-reason: ${JSON.stringify("no longer relevant")}`
      );
    }
    const noReason = applyDismissDecision(parseBlock(DECISION_RAW), "", T1);
    if ("dismissedBlock" in noReason) {
      expect(noReason.dismissedBlock.rawMeta).not.toContain("dismiss-reason:");
    }
  });

  it("preserves other rawMeta lines and body byte-identical (fence-bounded)", () => {
    const block = parseBlock(DECISION_RAW);
    const r = applyDismissDecision(block, undefined, T1);
    if ("dismissedBlock" in r) {
      expect(r.dismissedBlock.rawMeta).toContain("decision-id: TASK-999-plan");
      expect(r.dismissedBlock.rawMeta).toContain("blocking: true");
      expect(r.dismissedBlock.rawMeta).toContain('lean: "A"');
      expect(r.dismissedBlock.body).toBe(block.body);
    }
  });

  it("emits a dismissed-reply block from alex (body = reason, else 'Dismissed')", () => {
    const bare = applyDismissDecision(parseBlock(DECISION_RAW), undefined, T1);
    if ("dismissedBlock" in bare) {
      expect(bare.replyBlock.body).toBe("Dismissed");
      expect(bare.replyBlock.rawMeta).toContain("dismissed-reply: true");
      expect(bare.replyBlock.header.from).toBe("alex");
      expect(bare.replyBlock.header.status).toBe("sent");
    }
    const withReason = applyDismissDecision(parseBlock(DECISION_RAW), "moved on", T1);
    if ("dismissedBlock" in withReason) {
      expect(withReason.replyBlock.body).toBe("moved on");
    }
  });

  it("round-trips: reparse of serialized block sees card.dismissed + dismissReason", () => {
    const r = applyDismissDecision(parseBlock(DECISION_RAW), 'has "quotes": and colons', T1);
    if (!("dismissedBlock" in r)) throw new Error("should succeed");
    const reparsed = parseBlock(serializeBlock(r.dismissedBlock));
    expect(reparsed.card).toBeDefined();
    expect(reparsed.card!.dismissed).toBe(T1);
    expect(reparsed.card!.dismissReason).toBe('has "quotes": and colons');
  });

  it("round-trips a reason whose text is ITSELF a JSON string literal, preserving its quote chars", () => {
    // Regression for the double-decode bug: the note text is literally `"quoted"`
    // (six letters wrapped in real quote chars). The old parse ran a second
    // JSON.parse on the already-YAML-decoded value and stripped those quotes,
    // returning `quoted`. Single-decode must return the value verbatim.
    const reason = '"quoted"';
    const r = applyDismissDecision(parseBlock(DECISION_RAW), reason, T1);
    if (!("dismissedBlock" in r)) throw new Error("should succeed");
    const reparsed = parseBlock(serializeBlock(r.dismissedBlock));
    expect(reparsed.card!.dismissReason).toBe(reason);
  });
});

describe("applyDismissDecision - idempotency", () => {
  it("second dismiss is alreadyDismissed with the original timestamp, no rawMeta change", () => {
    const first = applyDismissDecision(parseBlock(DECISION_RAW), "r", T1);
    if (!("dismissedBlock" in first)) throw new Error("first should succeed");
    const metaAfterFirst = first.dismissedBlock.rawMeta;
    const second = applyDismissDecision(first.dismissedBlock, "different", T2);
    expect("alreadyDismissed" in second).toBe(true);
    if ("alreadyDismissed" in second) {
      expect(second.existingDismissedAt).toBe(T1);
    }
    expect(first.dismissedBlock.rawMeta).toBe(metaAfterFirst);
  });
});

// ===========================================================================
// applySupersedeAction / applySupersedeDecision - first application
// ===========================================================================

describe("applySupersedeAction - first application", () => {
  it("writes superseded: <ISO> (+ supersede-note) and emits a superseded-reply", () => {
    const r = applySupersedeAction(parseBlock(ACTION_RAW), "replaced by TASK-1000", T1);
    expect("supersededBlock" in r).toBe(true);
    if ("supersededBlock" in r) {
      expect(r.supersededAt).toBe(T1);
      expect(r.supersededBlock.rawMeta).toContain(`superseded: ${T1}`);
      expect(r.supersededBlock.rawMeta).toContain(
        `supersede-note: ${JSON.stringify("replaced by TASK-1000")}`
      );
      expect(r.replyBlock.rawMeta).toContain("superseded-reply: true");
      expect(r.replyBlock.body).toBe("replaced by TASK-1000");
      expect(r.replyBlock.header.from).toBe("alex");
    }
  });

  it("bare supersede body is 'Superseded' and omits supersede-note", () => {
    const r = applySupersedeAction(parseBlock(ACTION_RAW), undefined, T1);
    if ("supersededBlock" in r) {
      expect(r.supersededBlock.rawMeta).not.toContain("supersede-note:");
      expect(r.replyBlock.body).toBe("Superseded");
    }
  });

  it("round-trips: reparse sees actionCard.superseded + supersedeNote", () => {
    const r = applySupersedeAction(parseBlock(ACTION_RAW), "note\nwith newline", T1);
    if (!("supersededBlock" in r)) throw new Error("should succeed");
    const reparsed = parseBlock(serializeBlock(r.supersededBlock));
    expect(reparsed.actionCard).toBeDefined();
    expect(reparsed.actionCard!.superseded).toBe(T1);
    expect(reparsed.actionCard!.supersedeNote).toBe("note\nwith newline");
  });

  it("second supersede is alreadySuperseded (idempotent), no rawMeta change", () => {
    const first = applySupersedeAction(parseBlock(ACTION_RAW), "n", T1);
    if (!("supersededBlock" in first)) throw new Error("first should succeed");
    const metaAfterFirst = first.supersededBlock.rawMeta;
    const second = applySupersedeAction(first.supersededBlock, "again", T2);
    expect("alreadySuperseded" in second).toBe(true);
    if ("alreadySuperseded" in second) {
      expect(second.existingSupersededAt).toBe(T1);
    }
    expect(first.supersededBlock.rawMeta).toBe(metaAfterFirst);
  });
});

describe("applySupersedeDecision - first application", () => {
  it("writes superseded: <ISO> and round-trips card.superseded + supersedeNote", () => {
    const r = applySupersedeDecision(parseBlock(DECISION_RAW), "replaced", T1);
    expect("supersededBlock" in r).toBe(true);
    if ("supersededBlock" in r) {
      expect(r.supersededBlock.rawMeta).toContain(`superseded: ${T1}`);
      const reparsed = parseBlock(serializeBlock(r.supersededBlock));
      expect(reparsed.card).toBeDefined();
      expect(reparsed.card!.superseded).toBe(T1);
      expect(reparsed.card!.supersedeNote).toBe("replaced");
      expect(reparsed.card!.options.length).toBe(2);
    }
  });

  it("second supersede is alreadySuperseded (idempotent)", () => {
    const first = applySupersedeDecision(parseBlock(DECISION_RAW), "n", T1);
    if (!("supersededBlock" in first)) throw new Error("first should succeed");
    const second = applySupersedeDecision(first.supersededBlock, "again", T2);
    expect("alreadySuperseded" in second).toBe(true);
  });
});

// ===========================================================================
// DECISION matrix: answered / dismissed / superseded, both directions
// ===========================================================================

describe("decision mutual exclusion - answered vs dismissed", () => {
  it("answered decision cannot be dismissed (alreadyAnswered)", () => {
    const r = applyDismissDecision(answeredDecision(), "x", T2);
    expect("alreadyAnswered" in r).toBe(true);
    if ("alreadyAnswered" in r) expect(r.existingAnswer).toBe("A");
  });

  it("dismissed decision cannot be answered (alreadyDismissed)", () => {
    const r = applyAnswer(dismissedDecision(), "B");
    expect("alreadyDismissed" in r).toBe(true);
    if ("alreadyDismissed" in r) expect(r.existingDismissedAt).toBe(T1);
    expect("answeredOriginal" in r).toBe(false);
  });

  it("dismissed decision cannot be custom-answered (alreadyDismissed)", () => {
    const r = applyCustomAnswer(dismissedDecision(), "my own take");
    expect("alreadyDismissed" in r).toBe(true);
  });

  it("dismissed decision cannot be pushed back (alreadyResolved: dismissed)", () => {
    const r = applyPushBack(dismissedDecision());
    expect("alreadyResolved" in r).toBe(true);
    if ("alreadyResolved" in r) expect(r.existingState).toBe("dismissed");
  });
});

describe("decision mutual exclusion - answered vs superseded", () => {
  it("answered decision cannot be superseded (alreadyAnswered)", () => {
    const r = applySupersedeDecision(answeredDecision(), "x", T2);
    expect("alreadyAnswered" in r).toBe(true);
  });

  it("superseded decision cannot be answered (alreadySuperseded)", () => {
    const r = applyAnswer(supersededDecision(), "B");
    expect("alreadySuperseded" in r).toBe(true);
    if ("alreadySuperseded" in r) expect(r.existingSupersededAt).toBe(T1);
    expect("answeredOriginal" in r).toBe(false);
  });

  it("superseded decision cannot be custom-answered (alreadySuperseded)", () => {
    const r = applyCustomAnswer(supersededDecision(), "text");
    expect("alreadySuperseded" in r).toBe(true);
  });

  it("superseded decision cannot be pushed back (alreadyResolved: superseded)", () => {
    const r = applyPushBack(supersededDecision());
    expect("alreadyResolved" in r).toBe(true);
    if ("alreadyResolved" in r) expect(r.existingState).toBe("superseded");
  });
});

describe("decision mutual exclusion - dismissed vs superseded", () => {
  it("dismissed decision cannot be superseded (alreadyDismissed)", () => {
    const r = applySupersedeDecision(dismissedDecision(), "x", T2);
    expect("alreadyDismissed" in r).toBe(true);
    if ("alreadyDismissed" in r) expect(r.existingDismissedAt).toBe(T1);
  });

  it("superseded decision cannot be dismissed (alreadySuperseded)", () => {
    const r = applyDismissDecision(supersededDecision(), "x", T2);
    expect("alreadySuperseded" in r).toBe(true);
    if ("alreadySuperseded" in r) expect(r.existingSupersededAt).toBe(T1);
  });
});

describe("decision - pushback resolution also blocks the new writes", () => {
  it("pushed-back decision cannot be dismissed or superseded", () => {
    const pb = applyPushBack(parseBlock(DECISION_RAW));
    if (!("pushedBackOriginal" in pb)) throw new Error("pushback should succeed");
    expect("alreadyAnswered" in applyDismissDecision(pb.pushedBackOriginal, "x", T2)).toBe(true);
    expect("alreadyAnswered" in applySupersedeDecision(pb.pushedBackOriginal, "x", T2)).toBe(true);
  });
});

// ===========================================================================
// ACTION matrix: done / dismissed / superseded, both directions
// ===========================================================================

describe("action mutual exclusion - done vs superseded", () => {
  it("done action cannot be superseded (alreadyDone)", () => {
    const r = applySupersedeAction(doneAction(), "x", T2);
    expect("alreadyDone" in r).toBe(true);
  });

  it("superseded action cannot be marked done (alreadySuperseded)", () => {
    const r = applyDone(supersededAction(), T2);
    expect("alreadySuperseded" in r).toBe(true);
    if ("alreadySuperseded" in r) expect(r.existingSupersededAt).toBe(T1);
    expect("markedDone" in r).toBe(false);
  });
});

describe("action mutual exclusion - dismissed vs superseded", () => {
  it("dismissed action cannot be superseded (alreadyDismissed)", () => {
    const r = applySupersedeAction(dismissedAction(), "x", T2);
    expect("alreadyDismissed" in r).toBe(true);
    if ("alreadyDismissed" in r) expect(r.existingDismissedAt).toBe(T1);
  });

  it("superseded action cannot be dismissed (alreadySuperseded)", () => {
    const r = applyDismiss(supersededAction(), "x", T2);
    expect("alreadySuperseded" in r).toBe(true);
    if ("alreadySuperseded" in r) expect(r.existingSupersededAt).toBe(T1);
    expect("dismissedBlock" in r).toBe(false);
  });
});

describe("action mutual exclusion - done vs dismissed (existing behaviour still holds)", () => {
  it("done action cannot be dismissed and dismissed action reports honestly on done", () => {
    expect("alreadyDone" in applyDismiss(doneAction(), "x", T2)).toBe(true);
    const r = applyDone(dismissedAction(), T2);
    expect("alreadyDismissed" in r).toBe(true);
    expect("alreadyDone" in r).toBe(false);
  });
});

// ===========================================================================
// Decoy safety: state tokens in the BODY must not trigger a guard
// ===========================================================================

describe("decoy - state tokens in body are ignored (rawMeta-only guards)", () => {
  it("'superseded:' in the body does not make a card superseded", () => {
    const decoyDecision = [
      `## 2026-06-09T10:00:00Z - from: scribe - status: sent - subject: decoy`,
      `decision-id: TASK-999-decoy`,
      `options:`,
      `  - key: A`,
      `    label: "A"`,
      `    detail: "a"`,
      ``,
      `Note: superseded: 2020-01-01 and dismissed: 2020-01-01 appear in body only.`,
      ``,
      `---`,
    ].join("\n");
    const block = parseBlock(decoyDecision);
    expect(block.card!.superseded).toBeUndefined();
    expect(block.card!.dismissed).toBeUndefined();
    // A fresh answer/dismiss/supersede must all succeed (no phantom terminal state).
    expect("answeredOriginal" in applyAnswer(block, "A")).toBe(true);
    expect("dismissedBlock" in applyDismissDecision(block, undefined, T1)).toBe(true);
    expect("supersededBlock" in applySupersedeDecision(block, undefined, T1)).toBe(true);
  });
});
