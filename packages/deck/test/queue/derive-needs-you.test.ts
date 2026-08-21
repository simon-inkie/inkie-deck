/**
 * Unit tests for deriveNeedsYou (app/lib/queue-derive.ts).
 *
 * Covers:
 * - Three kinds (decision, action, blocked) all appear in output
 * - Decisions: excludes answered cards, and (since the sweep port) superseded ones
 * - Actions: excludes done actions, dismissed ones, and superseded ones
 * - Blocked: filters to column "blocked" only
 * - Ranking: overdue desc, priority asc, age desc, lexicographic id
 * - Interleaved kinds in correct rank order
 * - Tie stability: same priority + overdue -> older createdAt first
 * - Priority: high < medium (unset) < low
 * - handledIds exclusion
 * - newDeadlines contains only freshly-computed anchors
 * - MC_NOW determinism
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import { addHours } from "date-fns";
import { deriveNeedsYou } from "~/lib/queue-derive.js";
import type { InboxEntry } from "~/lib/queue-derive.js";
import type { MessageBlock } from "~/lib/blocks/model.js";
import type { ProjectCard } from "~/lib/projects.shared.js";

// ---------------------------------------------------------------------------
// Fixed clock
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-10T12:00:00Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecisionEntry(overrides: {
  agentName: string;
  timestamp: string;
  decisionId: string;
  answered?: string;
}): InboxEntry {
  const block: MessageBlock = {
    header: {
      timestamp: overrides.timestamp,
      from: overrides.agentName,
      status: "sent",
      subject: `Decision: ${overrides.decisionId}`,
    },
    body: "A decision body.",
    card: {
      decisionId: overrides.decisionId,
      options: [
        { key: "A", label: "Option A", detail: "" },
        { key: "B", label: "Option B", detail: "" },
      ],
      answered: overrides.answered,
    },
    rawMeta: `decision-id: ${overrides.decisionId}`,
  };
  return { agentName: overrides.agentName, block };
}

function makeActionEntry(overrides: {
  agentName: string;
  timestamp: string;
  actionId: string;
  priority?: string;
  ticket?: string;
  done?: string;
}): InboxEntry {
  const block: MessageBlock = {
    header: {
      timestamp: overrides.timestamp,
      from: overrides.agentName,
      status: "sent",
      subject: `Action: ${overrides.actionId}`,
    },
    body: "An action body.",
    actionCard: {
      actionId: overrides.actionId,
      priority: overrides.priority,
      ticket: overrides.ticket,
      done: overrides.done,
    },
    rawMeta: `action-id: ${overrides.actionId}`,
  };
  return { agentName: overrides.agentName, block };
}

function makeBlockedCard(overrides: {
  id: string;
  title: string;
  agent: string;
  updated: string;
  ticket?: string;
}): ProjectCard {
  return {
    id: overrides.id,
    title: overrides.title,
    agent: overrides.agent,
    column: "blocked",
    updated: overrides.updated,
    ticket: overrides.ticket,
    summary: "",
    body: "",
  };
}

function makeNonBlockedCard(overrides: {
  id: string;
  title: string;
  agent: string;
  updated: string;
}): ProjectCard {
  return {
    id: overrides.id,
    title: overrides.title,
    agent: overrides.agent,
    column: "in progress",
    updated: overrides.updated,
    summary: "",
    body: "",
  };
}

// ---------------------------------------------------------------------------
// Suite: basic filtering
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - filtering", () => {
  it("includes unanswered decision card", () => {
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-1",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("decision");
    expect(items[0]!.decisionId).toBe("dec-1");
  });

  it("excludes answered decision card", () => {
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-1",
      answered: "A",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("includes un-done action card", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-1",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("action");
    expect(items[0]!.actionId).toBe("act-1");
  });

  it("excludes done action card", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-1",
      done: "2026-06-10T11:00:00Z",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("includes blocked kanban card", () => {
    const card = makeBlockedCard({
      id: "task-398.md",
      title: "TASK-398 blocked",
      agent: "quill",
      updated: "2026-06-10T08:00:00Z",
    });
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("blocked");
    expect(items[0]!.title).toBe("TASK-398 blocked");
  });

  it("excludes non-blocked kanban cards", () => {
    const card = makeNonBlockedCard({
      id: "task-001.md",
      title: "In progress card",
      agent: "quill",
      updated: "2026-06-10T08:00:00Z",
    });
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("excludes entries where from === 'alex'", () => {
    const block: MessageBlock = {
      header: { timestamp: "2026-06-10T10:00:00Z", from: "alex", status: "sent", subject: "self" },
      body: "Alex's own message",
      rawMeta: "",
    };
    const { items } = deriveNeedsYou(
      [{ agentName: "quill", block }],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });

  it("excludes items whose id is in handledIds", () => {
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-handled",
    });
    const id = "quill/2026-06-10T10:00:00Z/dec-handled";
    const { items } = deriveNeedsYou(
      [entry],
      [],
      new Set([id]),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: ranking
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - ranking (overdue desc, priority asc, age desc)", () => {
  it("overdue item ranks before non-overdue item", () => {
    // Overdue: filed 2 days ago, 24h tier -> deadline 1 day ago
    const overdueEntry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-08T10:00:00Z",
      decisionId: "overdue-dec",
    });
    // Fresh: filed 1h ago
    const freshEntry = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T11:00:00Z",
      actionId: "fresh-act",
    });

    const { items } = deriveNeedsYou(
      [freshEntry, overdueEntry],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(2);
    expect(items[0]!.overdue).toBe(true);
    expect(items[0]!.kind).toBe("decision");
    expect(items[1]!.overdue).toBe(false);
    expect(items[1]!.kind).toBe("action");
  });

  it("high-priority action ranks before low-priority action (same overdue status)", () => {
    const highEntry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T11:00:00Z",
      actionId: "high-act",
      priority: "high",
    });
    const lowEntry = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T10:00:00Z", // older, so would rank first on age
      actionId: "low-act",
      priority: "low",
    });

    const { items } = deriveNeedsYou(
      [lowEntry, highEntry],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(2);
    expect(items[0]!.actionId).toBe("high-act");
    expect(items[1]!.actionId).toBe("low-act");
  });

  it("older createdAt ranks first among same priority and overdue status", () => {
    const olderEntry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T09:00:00Z",
      actionId: "older-act",
    });
    const newerEntry = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T11:00:00Z",
      actionId: "newer-act",
    });

    const { items } = deriveNeedsYou(
      [newerEntry, olderEntry],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(2);
    expect(items[0]!.actionId).toBe("older-act");
    expect(items[1]!.actionId).toBe("newer-act");
  });

  it("interleaved kinds: overdue decision > fresh high-priority action > fresh blocked", () => {
    const overdueDecision = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-08T10:00:00Z",
      decisionId: "overdue-dec",
    });
    const freshHighAction = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T11:00:00Z",
      actionId: "fresh-high-act",
      priority: "high",
    });
    const freshBlocked = makeBlockedCard({
      id: "task-001.md",
      title: "Fresh blocked",
      agent: "quill",
      updated: "2026-06-10T11:30:00Z",
    });

    const { items } = deriveNeedsYou(
      [freshHighAction, overdueDecision],
      [freshBlocked],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(3);
    expect(items[0]!.overdue).toBe(true);
    expect(items[0]!.kind).toBe("decision");
    // Next two are non-overdue; high action vs blocked (no priority)
    // high action has weight 0, blocked (no priority) has weight 1 -> action first
    expect(items[1]!.kind).toBe("action");
    expect(items[2]!.kind).toBe("blocked");
  });

  it("lexicographic id breaks remaining ties", () => {
    const entryA = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "zzz-act",
    });
    const entryB = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "aaa-act",
    });

    const { items } = deriveNeedsYou(
      [entryA, entryB],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(2);
    // Same timestamp and priority - sort by id lexicographically
    const ids = items.map(i => i.id);
    expect(ids[0]! < ids[1]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: deadline anchors and newDeadlines
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - deadline anchors", () => {
  it("deadline for a decision/action is 24h from timestamp (card tier)", () => {
    const ts = "2026-06-10T10:00:00Z";
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: ts,
      decisionId: "dec-1",
    });
    const { items, newDeadlines } = deriveNeedsYou(
      [entry],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(1);
    const expectedDeadline = addHours(new Date(ts), 24).toISOString();
    expect(items[0]!.deadline).toBe(expectedDeadline);
    const id = items[0]!.id;
    expect(newDeadlines.has(id)).toBe(true);
  });

  it("stored deadline anchor is reused (no drift)", () => {
    const ts = "2026-06-10T10:00:00Z";
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: ts,
      decisionId: "dec-stored",
    });
    const id = "quill/2026-06-10T10:00:00Z/dec-stored";
    const storedDeadline = "2026-06-11T15:00:00Z";
    const deadlineMap = new Map([[id, storedDeadline]]);

    const { items, newDeadlines } = deriveNeedsYou(
      [entry],
      [],
      new Set(),
      deadlineMap,
      FIXED_NOW
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.deadline).toBe(storedDeadline);
    expect(newDeadlines.has(id)).toBe(false);
  });

  it("blocked card deadline is 48h from updated (not stored in newDeadlines)", () => {
    const updated = "2026-06-10T08:00:00Z";
    const card = makeBlockedCard({
      id: "ink-blocked.md",
      title: "Blocked card",
      agent: "quill",
      updated,
    });

    const { items, newDeadlines } = deriveNeedsYou(
      [],
      [card],
      new Set(),
      new Map(),
      FIXED_NOW
    );

    expect(items).toHaveLength(1);
    const expectedDeadline = addHours(new Date(updated), 48).toISOString();
    expect(items[0]!.deadline).toBe(expectedDeadline);
    // Blocked cards are not persisted to newDeadlines
    expect(newDeadlines.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: deep links and metadata passthrough
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - deep links and metadata", () => {
  it("decision deep link is /threads/<agent>#<decisionId>", () => {
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-link",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items[0]!.deepLink).toBe("/threads/quill#dec-link");
  });

  it("action deep link is /threads/<agent>#<actionId>", () => {
    const entry = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-link",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items[0]!.deepLink).toBe("/threads/atlas#act-link");
  });

  it("blocked card deep link is /projects", () => {
    const card = makeBlockedCard({
      id: "ink-blocked.md",
      title: "Blocked",
      agent: "quill",
      updated: "2026-06-10T08:00:00Z",
    });
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items[0]!.deepLink).toBe("/projects");
  });

  it("action card priority and ticket pass through to NeedsYouItem", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-meta",
      priority: "high",
      ticket: "https://linear.app/example-org/issue/TASK-438",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items[0]!.priority).toBe("high");
    expect(items[0]!.ticket).toBe("https://linear.app/example-org/issue/TASK-438");
  });
});

// ---------------------------------------------------------------------------
// Suite: TASK-440 - dismissed exclusion
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - TASK-440 dismissed exclusion", () => {
  it("excludes dismissed action cards", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-dismissed",
      done: undefined,
    });
    // Inject dismissed state into the actionCard.
    entry.block.actionCard!.dismissed = "2026-06-10T11:00:00Z";

    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("includes undismissed action cards", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-not-dismissed",
    });
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("action");
  });
});

// ---------------------------------------------------------------------------
// Suite: superseded exclusion
//
// A BEHAVIOUR CHANGE, made with the activity-sweep port. Before it, a
// superseded card kept driving the homepage and the bell for the rest of its
// 72h card window, while isDecisionResolved, isActionResolved, the card
// components and the Cards tab all treated it as closed. One repository, three
// answers. The port makes that visible to a person, because the sweep publishes
// its own needs-you status read from the same files.
//
// A DISMISSED DECISION is deliberately NOT here: it remains visible on the
// homepage, which is the surviving half of the Option-1 freeze. See
// derive-cards-tab.test.ts, where the two filters are pinned against each other.
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - superseded exclusion", () => {
  it("excludes superseded decision cards", () => {
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-superseded",
    });
    entry.block.card!.superseded = "2026-06-10T11:00:00Z";

    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("excludes superseded action cards", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-superseded",
    });
    entry.block.actionCard!.superseded = "2026-06-10T11:00:00Z";

    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(0);
  });

  it("a superseded card does not suppress its open neighbours", () => {
    const superseded = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-superseded",
    });
    superseded.block.card!.superseded = "2026-06-10T11:00:00Z";
    const open = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:01:00Z",
      decisionId: "dec-open",
    });

    const { items } = deriveNeedsYou(
      [superseded, open],
      [],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items.map((i) => i.decisionId)).toEqual(["dec-open"]);
  });

  it("an empty superseded value is not a resolution", () => {
    // Protocol section 7.1.1: a reader MUST require a non-empty value. The
    // parser drops an empty timestamp rather than storing "", so what reaches
    // this function is undefined; assert the shape that actually arrives.
    const entry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-blank",
    });
    entry.block.card!.superseded = undefined;

    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: TASK-440 - summary threading for blocked items
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - TASK-440 blocked summary threading", () => {
  it("blocked item includes summary when card.summary is non-empty", () => {
    const card: ProjectCard = {
      id: "ink-blocked-summary.md",
      title: "Blocked card with summary",
      agent: "quill",
      column: "blocked",
      updated: "2026-06-10T08:00:00Z",
      summary: "Waiting on external API approval",
      body: "Waiting on external API approval - more details here.",
    };
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toBe("Waiting on external API approval");
  });

  it("blocked item includes blockedOn when card.blockedOn is present", () => {
    const card: ProjectCard = {
      id: "ink-blocked-on.md",
      title: "Blocked with blocker",
      agent: "quill",
      column: "blocked",
      updated: "2026-06-10T08:00:00Z",
      summary: "Some summary",
      body: "Some body",
      blockedOn: "Alex Deepgram key",
    };
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.blockedOn).toBe("Alex Deepgram key");
  });

  it("blocked item has no summary when card.summary is empty", () => {
    const card: ProjectCard = {
      id: "ink-no-summary.md",
      title: "No summary card",
      agent: "quill",
      column: "blocked",
      updated: "2026-06-10T08:00:00Z",
      summary: "",
      body: "",
    };
    const { items } = deriveNeedsYou([], [card], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toBeUndefined();
  });

  it("decisions and actions do not have summary field", () => {
    const decEntry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "no-summary-dec",
    });
    const actEntry = makeActionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "no-summary-act",
    });
    const { items } = deriveNeedsYou([decEntry, actEntry], [], new Set(), new Map(), FIXED_NOW);
    expect(items.find(i => i.kind === "decision")!.summary).toBeUndefined();
    expect(items.find(i => i.kind === "action")!.summary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: TASK-440 - badge=sum invariant pin
// ---------------------------------------------------------------------------

describe("deriveNeedsYou - TASK-440 badge=sum invariant", () => {
  it("sum of per-kind counts equals items.length", () => {
    const decEntry = makeDecisionEntry({
      agentName: "quill",
      timestamp: "2026-06-10T10:00:00Z",
      decisionId: "dec-badge",
    });
    const actEntry = makeActionEntry({
      agentName: "atlas",
      timestamp: "2026-06-10T10:00:00Z",
      actionId: "act-badge",
    });
    const blockedCard: ProjectCard = {
      id: "ink-badge-blocked.md",
      title: "Badge blocked",
      agent: "quill",
      column: "blocked",
      updated: "2026-06-10T08:00:00Z",
      summary: "",
      body: "",
    };
    const { items } = deriveNeedsYou(
      [decEntry, actEntry],
      [blockedCard],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    const decisions = items.filter(i => i.kind === "decision").length;
    const todos = items.filter(i => i.kind === "action").length;
    const blocked = items.filter(i => i.kind === "blocked").length;
    expect(decisions + todos + blocked).toBe(items.length);
    expect(decisions).toBe(1);
    expect(todos).toBe(1);
    expect(blocked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed-timestamp guard (2026-06-11 MC lifeline incident)
//
// A block whose header timestamp failed to parse leaves an empty timestamp on
// a block that still carries a card. deriveNeedsYou must NOT throw "Invalid
// time value" - it must degrade to a now-based deadline so one bad block can
// never 500 the whole queue loader.
// ---------------------------------------------------------------------------
describe("deriveNeedsYou malformed-timestamp guard", () => {
  it("does not throw on a decision card with an empty timestamp", () => {
    const entry = makeDecisionEntry({
      agentName: "atlas",
      timestamp: "",
      decisionId: "AFFILIATE-404-FIX",
    });
    expect(() =>
      deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW)
    ).not.toThrow();
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    // Deadline must be a valid ISO string (fallback computed from now).
    expect(isNaN(new Date(items[0]!.deadline).getTime())).toBe(false);
  });

  it("does not throw on an action card with a garbage timestamp", () => {
    const entry = makeActionEntry({
      agentName: "quill",
      timestamp: "not-a-real-date",
      actionId: "power-bios-acloss",
    });
    expect(() =>
      deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW)
    ).not.toThrow();
    const { items } = deriveNeedsYou([entry], [], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(isNaN(new Date(items[0]!.deadline).getTime())).toBe(false);
  });

  it("does not throw on a blocked card with an empty updated timestamp", () => {
    const blockedCard: ProjectCard = {
      id: "ink-bad.md",
      title: "Bad timestamp",
      agent: "quill",
      column: "blocked",
      updated: "",
      summary: "",
      body: "",
    };
    expect(() =>
      deriveNeedsYou([], [blockedCard], new Set(), new Map(), FIXED_NOW)
    ).not.toThrow();
    const { items } = deriveNeedsYou([], [blockedCard], new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(isNaN(new Date(items[0]!.deadline).getTime())).toBe(false);
  });
});
