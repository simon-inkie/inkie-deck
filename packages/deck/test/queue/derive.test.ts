/**
 * Unit tests for app/lib/queue-derive.ts
 *
 * Tests cover:
 * - deriveItemId construction
 * - Ranking (overdue-first, soonest deadline, older createdAt, lexicographic id)
 * - Deterministic sort order (two identical calls produce the same id ordering)
 * - Ageing display with injected clock
 * - Overdue items stay (QUEUE-06)
 * - QUEUE-09: a new reply after a handled item is NOT suppressed
 * - All-handled returns empty
 * - Deadline anchor reused from map (no drift)
 * - From=alex blocks are excluded
 * - Answered cards are excluded (reconciliation)
 * - Card items get 24h tier, plain items get 48h tier (QUEUE-02)
 * - newDeadlines only contains new ids (not those already in the map)
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import { addHours } from "date-fns";
import { deriveQueueItems, deriveItemId } from "~/lib/queue-derive.js";
import type { MessageBlock } from "~/lib/blocks/model.js";

// Fixed reference point for deterministic tests.
// NOW is set 10 hours after the plain anchor to make one item overdue.
const BASE_TS = "2026-06-01T10:00:00Z";
const FIXED_NOW = new Date("2026-06-03T12:00:00Z"); // well after 48h deadline

/** Make a plain (non-card) block. Override as needed. */
function makeBlock(overrides: {
  timestamp: string;
  from: string;
  body?: string;
}): MessageBlock {
  return {
    header: {
      timestamp: overrides.timestamp,
      from: overrides.from,
      status: "sent",
      subject: "test",
    },
    body: overrides.body ?? "body text",
    card: undefined,
    rawMeta: "",
  };
}

/** Make a card block with an optional answered field. */
function makeCardBlock(overrides: {
  timestamp: string;
  from: string;
  decisionId: string;
  answered?: string;
}): MessageBlock {
  return {
    header: {
      timestamp: overrides.timestamp,
      from: overrides.from,
      status: "sent",
      subject: "card test",
    },
    body: "card body",
    card: {
      decisionId: overrides.decisionId,
      options: [
        { key: "A", label: "Option A", detail: "" },
        { key: "B", label: "Option B", detail: "" },
      ],
      answered: overrides.answered,
    },
    rawMeta: "",
  };
}

describe("deriveItemId", () => {
  it("returns agentName/timestamp/from for plain blocks", () => {
    const block = makeBlock({ timestamp: "2026-06-01T10:00:00Z", from: "agent-x" });
    const id = deriveItemId("agent-x", block);
    expect(id).toBe("agent-x/2026-06-01T10:00:00Z/agent-x");
  });

  it("returns agentName/timestamp/decisionId for card blocks", () => {
    const block = makeCardBlock({
      timestamp: "2026-06-01T10:00:00Z",
      from: "agent-x",
      decisionId: "TASK-001",
    });
    const id = deriveItemId("agent-x", block);
    expect(id).toBe("agent-x/2026-06-01T10:00:00Z/TASK-001");
  });
});

describe("deriveQueueItems - basic filtering", () => {
  it("excludes blocks where from === 'alex'", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "alex" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });

  it("excludes blocks whose id is in handledIds", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a" });
    const id = deriveItemId("agent-a", block);
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set([id]),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });

  it("excludes answered card blocks (reconciliation)", () => {
    const block = makeCardBlock({
      timestamp: BASE_TS,
      from: "agent-a",
      decisionId: "TASK-001",
      answered: "B",
    });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });

  it("all-handled returns empty items", () => {
    const b1 = makeBlock({ timestamp: "2026-06-01T10:00:00Z", from: "agent-a" });
    const b2 = makeBlock({ timestamp: "2026-06-01T11:00:00Z", from: "agent-b" });
    const id1 = deriveItemId("agent-a", b1);
    const id2 = deriveItemId("agent-b", b2);
    const { items } = deriveQueueItems(
      [
        { agentName: "agent-a", block: b1 },
        { agentName: "agent-b", block: b2 },
      ],
      new Set([id1, id2]),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(0);
  });
});

describe("deriveQueueItems - deadline tiering (QUEUE-02)", () => {
  it("card items get a 24h deadline offset", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeCardBlock({ timestamp: ts, from: "agent-a", decisionId: "TASK-001" });
    const nowBefore24h = new Date("2026-06-02T09:00:00Z"); // 23h after - not yet overdue
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowBefore24h
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(false);
    // Deadline should be ts + 24h
    expect(items[0]!.deadline).toBe(addHours(new Date(ts), 24).toISOString());
  });

  it("card items become overdue after 24h", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeCardBlock({ timestamp: ts, from: "agent-a", decisionId: "TASK-001" });
    const nowAfter24h = new Date("2026-06-02T11:00:00Z"); // 25h after
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowAfter24h
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
  });

  it("plain items get a 48h deadline offset", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const nowBefore48h = new Date("2026-06-03T09:00:00Z"); // 47h after - not yet overdue
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowBefore48h
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(false);
    expect(items[0]!.deadline).toBe(addHours(new Date(ts), 48).toISOString());
  });

  it("plain items become overdue after 48h", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const nowAfter48h = new Date("2026-06-03T11:00:00Z"); // 49h after
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowAfter48h
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
  });
});

describe("deriveQueueItems - deadline anchor (QUEUE-05 / no drift)", () => {
  it("deadline anchor is reused from deadlineMap when present", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const id = deriveItemId("agent-a", block);
    const storedDeadline = "2026-06-02T12:00:00Z"; // custom anchor (not ts+48h)
    const deadlineMap = new Map([[id, storedDeadline]]);

    const { items, newDeadlines } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      deadlineMap,
      FIXED_NOW
    );
    expect(items).toHaveLength(1);
    // Reuses the stored anchor, not recomputed
    expect(items[0]!.deadline).toBe(storedDeadline);
    // Does NOT add to newDeadlines since it was already in the map
    expect(newDeadlines.has(id)).toBe(false);
  });

  it("new deadline anchor is added to newDeadlines", () => {
    const ts = "2026-06-01T10:00:00Z";
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const id = deriveItemId("agent-a", block);

    const { newDeadlines } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(newDeadlines.has(id)).toBe(true);
    expect(newDeadlines.get(id)).toBe(addHours(new Date(ts), 48).toISOString());
  });
});

describe("deriveQueueItems - preview", () => {
  it("collapses newlines to spaces and trims", () => {
    const block = makeBlock({
      timestamp: BASE_TS,
      from: "agent-a",
      body: "  line1\nline2  ",
    });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.preview).toBe("line1 line2");
  });

  it("slices to 80 characters", () => {
    const longBody = "x".repeat(100);
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a", body: longBody });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.preview.length).toBe(80);
  });

  it("falls back to '(no body)' for empty body", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a", body: "   " });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.preview).toBe("(no body)");
  });
});

describe("deriveQueueItems - overdue item stays (QUEUE-06)", () => {
  it("overdue item is present with overdue===true, not filtered out", () => {
    const ts = "2026-06-01T00:00:00Z";
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    // FIXED_NOW is well past 48h deadline
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
  });

  it("overdue items sort before non-overdue items", () => {
    const overdueTs = "2026-06-01T00:00:00Z"; // well past 48h
    const freshTs = "2026-06-03T11:00:00Z";    // just 1h old

    const overdueBlock = makeBlock({ timestamp: overdueTs, from: "agent-a" });
    const freshBlock = makeBlock({ timestamp: freshTs, from: "agent-b" });

    const nowForTest = new Date("2026-06-03T12:00:00Z");

    const { items } = deriveQueueItems(
      [
        { agentName: "agent-b", block: freshBlock },
        { agentName: "agent-a", block: overdueBlock },
      ],
      new Set(),
      new Map(),
      nowForTest
    );

    expect(items).toHaveLength(2);
    expect(items[0]!.overdue).toBe(true);
    expect(items[1]!.overdue).toBe(false);
  });
});

describe("deriveQueueItems - QUEUE-09 new reply after handled item", () => {
  it("a new reply from the same agent after a handled block is not suppressed", () => {
    const agent = "ambassador-agent";

    // Older block - Alex handled this one
    const oldBlock = makeBlock({
      timestamp: "2026-06-01T10:00:00Z",
      from: agent,
      body: "Hello Alex, are you available?",
    });
    const oldId = deriveItemId(agent, oldBlock);

    // Newer block from same agent - a follow-up, different timestamp
    const newBlock = makeBlock({
      timestamp: "2026-06-02T14:00:00Z",
      from: agent,
      body: "Following up - just checking in again",
    });
    const newId = deriveItemId(agent, newBlock);

    // Old block is handled; new block is not
    const handledIds = new Set([oldId]);

    const { items } = deriveQueueItems(
      [
        { agentName: agent, block: oldBlock },
        { agentName: agent, block: newBlock },
      ],
      handledIds,
      new Map(),
      FIXED_NOW
    );

    // Only the NEW block should appear
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(newId);
    expect(items[0]!.id).not.toBe(oldId);
  });

  it("deriveItemId differs for blocks with different timestamps from same agent", () => {
    const agent = "ambassador-agent";
    const block1 = makeBlock({ timestamp: "2026-06-01T10:00:00Z", from: agent });
    const block2 = makeBlock({ timestamp: "2026-06-02T14:00:00Z", from: agent });
    expect(deriveItemId(agent, block1)).not.toBe(deriveItemId(agent, block2));
  });
});

describe("deriveQueueItems - determinism (QUEUE-03/04)", () => {
  it("two calls with identical inputs return identical sort order", () => {
    const blocks = [
      makeBlock({ timestamp: "2026-06-01T08:00:00Z", from: "agent-c" }),
      makeBlock({ timestamp: "2026-06-01T09:00:00Z", from: "agent-a" }),
      makeBlock({ timestamp: "2026-06-01T07:00:00Z", from: "agent-b" }),
    ];
    const entries = blocks.map((block, i) => ({ agentName: `agent-${["c", "a", "b"][i]}`, block }));

    const result1 = deriveQueueItems(entries, new Set(), new Map(), FIXED_NOW);
    const result2 = deriveQueueItems(entries, new Set(), new Map(), FIXED_NOW);

    expect(result1.items.map((i) => i.id)).toEqual(result2.items.map((i) => i.id));
  });

  it("soonest deadline sorts before later deadline among non-overdue items", () => {
    // Both in the future but different deadlines
    const nowForTest = new Date("2026-06-01T11:00:00Z"); // 1h after BASE_TS

    // Earlier block - sooner 48h deadline
    const block1 = makeBlock({ timestamp: "2026-06-01T10:00:00Z", from: "agent-a" });
    // Later block - later 48h deadline
    const block2 = makeBlock({ timestamp: "2026-06-01T10:30:00Z", from: "agent-b" });

    const { items } = deriveQueueItems(
      [
        { agentName: "agent-b", block: block2 },
        { agentName: "agent-a", block: block1 },
      ],
      new Set(),
      new Map(),
      nowForTest
    );

    expect(items).toHaveLength(2);
    // agent-a has the earlier deadline, should be first
    expect(items[0]!.agentName).toBe("agent-a");
    expect(items[1]!.agentName).toBe("agent-b");
  });

  it("older createdAt sorts first when deadlines are equal", () => {
    // Both blocks from same agent with same timestamp -> would need same deadline
    // Use a deadlineMap to force identical deadlines
    const ts1 = "2026-06-01T10:00:00Z";
    const ts2 = "2026-06-01T10:30:00Z";
    const block1 = makeBlock({ timestamp: ts1, from: "agent-a" });
    const block2 = makeBlock({ timestamp: ts2, from: "agent-b" });
    const id1 = deriveItemId("agent-a", block1);
    const id2 = deriveItemId("agent-b", block2);

    const sharedDeadline = "2026-06-03T10:00:00Z";
    const deadlineMap = new Map([
      [id1, sharedDeadline],
      [id2, sharedDeadline],
    ]);

    const nowForTest = new Date("2026-06-03T09:00:00Z"); // before deadline, not overdue

    const { items } = deriveQueueItems(
      [
        { agentName: "agent-b", block: block2 },
        { agentName: "agent-a", block: block1 },
      ],
      new Set(),
      deadlineMap,
      nowForTest
    );

    expect(items).toHaveLength(2);
    // Older block (ts1) should sort first
    expect(items[0]!.createdAt).toBe(ts1);
    expect(items[1]!.createdAt).toBe(ts2);
  });
});

describe("deriveQueueItems - item shape", () => {
  it("returns handled: false for every item in the list", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.handled).toBe(false);
  });

  it("isCard is true for card blocks", () => {
    const block = makeCardBlock({ timestamp: BASE_TS, from: "agent-a", decisionId: "TASK-001" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.isCard).toBe(true);
    expect(items[0]!.decisionId).toBe("TASK-001");
  });

  it("isCard is false for plain blocks", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.isCard).toBe(false);
    expect(items[0]!.decisionId).toBeUndefined();
  });

  it("agentName is set from the entry agentName", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-from" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-name-key", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.agentName).toBe("agent-name-key");
  });

  it("createdAt matches the block header timestamp", () => {
    const block = makeBlock({ timestamp: BASE_TS, from: "agent-a" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      FIXED_NOW
    );
    expect(items[0]!.createdAt).toBe(BASE_TS);
  });
});

// ---------------------------------------------------------------------------
// ageDisplay - QUEUE-05 regression (argument-order guard)
// ---------------------------------------------------------------------------
// Regression: ageDisplay must read "in X" for a FUTURE deadline, not "X ago".
// The bug was formatDistance(now, deadline) which yields "X ago" for future items
// because formatDistance(a, b) describes a's position relative to b, and when
// a (now) is before b (future deadline), date-fns says "now was X ago from future".
// Correct form: formatDistance(deadline, now) which says "deadline is in X" when
// deadline > now, and "deadline was X ago" when deadline < now.
describe("deriveQueueItems - ageDisplay wording (QUEUE-05 regression)", () => {
  it("future deadline reads 'in X' not 'X ago'", () => {
    // Item created 1h ago; plain tier = 48h deadline; deadline is ~47h in the future.
    const ts = "2026-06-03T11:00:00Z";
    const nowForTest = new Date("2026-06-03T12:00:00Z"); // 1h after creation
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowForTest
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(false);
    // Must start with "in" for a future deadline, never end with "ago"
    expect(items[0]!.ageDisplay).toMatch(/^in /);
    expect(items[0]!.ageDisplay).not.toMatch(/ago$/);
  });

  it("overdue deadline reads 'X ago' not 'in X'", () => {
    // Item created 50h ago; plain tier = 48h deadline; deadline is 2h in the past.
    const ts = "2026-06-01T10:00:00Z";
    const nowForTest = new Date("2026-06-03T12:00:00Z"); // 50h after creation
    const block = makeBlock({ timestamp: ts, from: "agent-a" });
    const { items } = deriveQueueItems(
      [{ agentName: "agent-a", block }],
      new Set(),
      new Map(),
      nowForTest
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
    // Must end with "ago" for a past deadline, never start with "in"
    expect(items[0]!.ageDisplay).toMatch(/ago$/);
    expect(items[0]!.ageDisplay).not.toMatch(/^in /);
  });
});
