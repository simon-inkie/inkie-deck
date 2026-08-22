/**
 * Unit tests for deriveCardsTab + the homepage terminal-state agreement
 * (app/lib/queue-derive.ts, Thread C).
 *
 * deriveCardsTab is the dedicated Decisions+Actions tab's OWN filter. It checks
 * EVERY terminal state so a card closed on the tab leaves it immediately.
 *
 * The second block below is where the two filters are held against each other.
 * It used to assert that deriveNeedsYou ignored the new terminal states
 * entirely (the Option-1 freeze), then that it ignored only a dismissed
 * decision. It now pins that the tab and the homepage AGREE on every terminal
 * state, which is the property actually worth guarding.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import {
  deriveCardsTab,
  deriveNeedsYou,
  isDecisionResolved,
  isActionResolved,
} from "~/lib/queue-derive.js";
import type { InboxEntry } from "~/lib/queue-derive.js";
import type { MessageBlock } from "~/lib/blocks/model.js";

const FIXED_NOW = new Date("2026-06-10T12:00:00Z");

function decisionEntry(o: {
  agentName: string;
  timestamp: string;
  decisionId: string;
  answered?: string;
  dismissed?: string;
  superseded?: string;
  from?: string;
}): InboxEntry {
  const block: MessageBlock = {
    header: {
      timestamp: o.timestamp,
      from: o.from ?? o.agentName,
      status: "sent",
      subject: `Decision: ${o.decisionId}`,
    },
    body: "body",
    card: {
      decisionId: o.decisionId,
      options: [{ key: "A", label: "A", detail: "" }],
      answered: o.answered,
      dismissed: o.dismissed,
      superseded: o.superseded,
    },
    rawMeta: `decision-id: ${o.decisionId}`,
  };
  return { agentName: o.agentName, block };
}

function actionEntry(o: {
  agentName: string;
  timestamp: string;
  actionId: string;
  done?: string;
  dismissed?: string;
  superseded?: string;
  from?: string;
}): InboxEntry {
  const block: MessageBlock = {
    header: {
      timestamp: o.timestamp,
      from: o.from ?? o.agentName,
      status: "sent",
      subject: `Action: ${o.actionId}`,
    },
    body: "body",
    actionCard: {
      actionId: o.actionId,
      done: o.done,
      dismissed: o.dismissed,
      superseded: o.superseded,
    },
    rawMeta: `action-id: ${o.actionId}`,
  };
  return { agentName: o.agentName, block };
}

// ---------------------------------------------------------------------------
// isDecisionResolved / isActionResolved
// ---------------------------------------------------------------------------

describe("terminal-state predicates", () => {
  it("decision is resolved by answered / dismissed / superseded", () => {
    expect(isDecisionResolved({})).toBe(false);
    expect(isDecisionResolved({ answered: "A" })).toBe(true);
    expect(isDecisionResolved({ answered: "pushback" })).toBe(true);
    expect(isDecisionResolved({ dismissed: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isDecisionResolved({ superseded: "2026-01-01T00:00:00Z" })).toBe(true);
  });

  it("action is resolved by done / dismissed / superseded", () => {
    expect(isActionResolved({})).toBe(false);
    expect(isActionResolved({ done: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isActionResolved({ dismissed: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isActionResolved({ superseded: "2026-01-01T00:00:00Z" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveCardsTab filtering
// ---------------------------------------------------------------------------

describe("deriveCardsTab - filtering", () => {
  it("includes a live decision and a live action", () => {
    const items = deriveCardsTab([
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", decisionId: "d1" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T11:00:00Z", actionId: "a1" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["decision", "action"]);
  });

  it("excludes every decision terminal state (answered, dismissed, superseded)", () => {
    const items = deriveCardsTab([
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", decisionId: "answered", answered: "A" }),
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:01:00Z", decisionId: "dismissed", dismissed: "2026-06-10T10:30:00Z" }),
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:02:00Z", decisionId: "superseded", superseded: "2026-06-10T10:30:00Z" }),
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:03:00Z", decisionId: "live" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.block.card!.decisionId).toBe("live");
  });

  it("excludes every action terminal state (done, dismissed, superseded)", () => {
    const items = deriveCardsTab([
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", actionId: "done", done: "2026-06-10T10:30:00Z" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:01:00Z", actionId: "dismissed", dismissed: "2026-06-10T10:30:00Z" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:02:00Z", actionId: "superseded", superseded: "2026-06-10T10:30:00Z" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:03:00Z", actionId: "live" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.block.actionCard!.actionId).toBe("live");
  });

  it("excludes the instance user's own messages", () => {
    const items = deriveCardsTab(
      [decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", decisionId: "mine", from: "alex" })],
      "alex"
    );
    expect(items).toHaveLength(0);
  });

  it("sorts oldest (stalest) first, tie-broken deterministically", () => {
    const items = deriveCardsTab([
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T11:00:00Z", decisionId: "newer" }),
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T09:00:00Z", decisionId: "older" }),
    ]);
    expect(items.map((i) => i.block.card!.decisionId)).toEqual(["older", "newer"]);
  });

  it("equal timestamps break the tie by agentName (ascending), then card id", () => {
    const T = "2026-06-10T10:00:00Z";
    const items = deriveCardsTab([
      decisionEntry({ agentName: "sprout", timestamp: T, decisionId: "z" }),
      decisionEntry({ agentName: "nova", timestamp: T, decisionId: "m" }),
      decisionEntry({ agentName: "nova", timestamp: T, decisionId: "a" }),
    ]);
    // nova before sprout; within nova, id "a" before "m".
    expect(items.map((i) => `${i.agentName}/${i.block.card!.decisionId}`)).toEqual([
      "nova/a",
      "nova/m",
      "sprout/z",
    ]);
  });

  it("an entry with an invalid timestamp sorts after valid ones, deterministically", () => {
    const items = deriveCardsTab([
      decisionEntry({ agentName: "quill", timestamp: "", decisionId: "bad" }),
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T09:00:00Z", decisionId: "good" }),
    ]);
    // Valid timestamp sorts ahead of the NaN (empty) one; no non-deterministic swap.
    expect(items.map((i) => i.block.card!.decisionId)).toEqual(["good", "bad"]);
  });

  it("two invalid timestamps still tie-break by agentName/id (no NaN-driven randomness)", () => {
    const items = deriveCardsTab([
      decisionEntry({ agentName: "sprout", timestamp: "", decisionId: "x" }),
      decisionEntry({ agentName: "nova", timestamp: "not-a-date", decisionId: "y" }),
    ]);
    expect(items.map((i) => i.agentName)).toEqual(["nova", "sprout"]);
  });

  it("does not include blocked kanban cards (decisions + actions only)", () => {
    // deriveCardsTab takes only inbox entries - no blockedCards parameter -
    // so blocked project cards can never appear here by construction.
    const items = deriveCardsTab([]);
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// One-definition-of-resolved guard: the tab and the homepage never disagree
// ---------------------------------------------------------------------------

describe("resolved means the same thing on the Cards tab and the homepage", () => {
  // WHAT CHANGED AND WHY, TWICE, because a reader should see two intentional
  // inversions rather than a quietly rewritten assertion.
  //
  // These cases first asserted that deriveNeedsYou ignored the new terminal
  // states entirely, under the name "Option 1 guard - deriveNeedsYou is
  // unchanged by the new states". Option 1 froze the homepage/bell contract
  // when dismiss and supersede landed, so a closed card went on driving the
  // homepage while every other surface in this repository treated it as
  // closed. That was invisible until the activity sweep arrived: the sweep
  // publishes a needs-you status read from the same files, so the disagreement
  // started showing to a person. SUPERSEDED was harmonised then.
  //
  // DISMISSED on a decision was left divergent at that point, deliberately and
  // separately, and pinned by a case in this suite. That is what has now been
  // inverted: the fence was a landing constraint, not an intent that closed
  // work should sit on the homepage until it ages out of its card window. Both
  // derives call isDecisionResolved / isActionResolved, so the surfaces cannot
  // drift apart again.
  it("a SUPERSEDED decision is excluded from the homepage (was: still surfaced)", () => {
    const entry = decisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "d2",
      superseded: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.map((i) => i.decisionId)).not.toContain("d2");
    // The two surfaces now agree, which is the whole point of the change.
    expect(deriveCardsTab([entry])).toHaveLength(0);
    expect(isDecisionResolved(entry.block.card!)).toBe(true);
  });

  it("a SUPERSEDED action is excluded from the homepage (was: still surfaced)", () => {
    const entry = actionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "a1",
      superseded: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.map((i) => i.actionId)).not.toContain("a1");
    expect(deriveCardsTab([entry])).toHaveLength(0);
    expect(isActionResolved(entry.block.actionCard!)).toBe(true);
  });

  it("an open decision and an open action stay on BOTH surfaces", () => {
    // Positive control: neither derive passes by excluding everything.
    const entries = [
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", decisionId: "d-open" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:01:00Z", actionId: "a-open" }),
    ];
    const { items } = deriveNeedsYou(entries, [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(2);
    expect(deriveCardsTab(entries)).toHaveLength(2);
  });

  // THE LAST STATE TO BE HARMONISED. This case asserted the opposite until the
  // dismissed half of the Option-1 freeze was lifted: a dismissed DECISION was
  // resolved on every surface except the homepage and the bell. A dismissed
  // ACTION was already excluded there, so the divergence was one state on one
  // card kind, and this is the case that used to hold it in place.
  it("a DISMISSED decision leaves BOTH the tab and the homepage (was: still surfaced)", () => {
    const entry = decisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "d1",
      dismissed: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.map((i) => i.decisionId)).not.toContain("d1");
    expect(deriveCardsTab([entry])).toHaveLength(0);
    expect(isDecisionResolved(entry.block.card!)).toBe(true);
  });

  it("an ANSWERED decision and a DONE/DISMISSED action stay excluded from the homepage (existing behaviour intact)", () => {
    const entries = [
      decisionEntry({ agentName: "quill", timestamp: "2026-06-10T10:00:00Z", decisionId: "ans", answered: "A" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:01:00Z", actionId: "done", done: "2026-06-10T10:30:00Z" }),
      actionEntry({ agentName: "quill", timestamp: "2026-06-10T10:02:00Z", actionId: "dis", dismissed: "2026-06-10T10:30:00Z" }),
    ];
    const { items } = deriveNeedsYou(entries, [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });
});
