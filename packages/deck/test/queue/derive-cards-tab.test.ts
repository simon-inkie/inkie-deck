/**
 * Unit tests for deriveCardsTab + the Option-1 homepage-unchanged guard
 * (app/lib/queue-derive.ts, Thread C).
 *
 * deriveCardsTab is the dedicated Decisions+Actions tab's OWN filter. Unlike
 * deriveNeedsYou (the frozen homepage/bell contract), it checks EVERY terminal
 * state so a card closed on the tab leaves it immediately.
 *
 * The homepage-unchanged guard proves Option 1 stayed Option 1: deriveNeedsYou
 * is UNTOUCHED, so the new terminal states are invisible to it (a dismissed or
 * superseded decision, and a superseded action, still surface on the homepage /
 * bell). This is the deliberate consequence of not editing deriveNeedsYou.
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
// Option-1 homepage-unchanged guard: deriveNeedsYou is UNTOUCHED
// ---------------------------------------------------------------------------

describe("Option 1 guard - deriveNeedsYou is unchanged by the new states", () => {
  it("a DISMISSED decision still surfaces on the homepage (deriveNeedsYou only checks answered)", () => {
    const entry = decisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "d1",
      dismissed: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    // Present on the homepage (the deliberate Option-1 consequence)...
    expect(items.map((i) => i.decisionId)).toContain("d1");
    // ...but absent from the dedicated tab, which checks every terminal state.
    expect(deriveCardsTab([entry])).toHaveLength(0);
  });

  it("a SUPERSEDED decision still surfaces on the homepage", () => {
    const entry = decisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "d2",
      superseded: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.map((i) => i.decisionId)).toContain("d2");
    expect(deriveCardsTab([entry])).toHaveLength(0);
  });

  it("a SUPERSEDED action still surfaces on the homepage (deriveNeedsYou checks only done + dismissed)", () => {
    const entry = actionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "a1",
      superseded: "2026-06-10T10:30:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.map((i) => i.actionId)).toContain("a1");
    expect(deriveCardsTab([entry])).toHaveLength(0);
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
