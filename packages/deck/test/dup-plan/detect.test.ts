/**
 * Unit tests for app/lib/dup-plan-detect.ts
 *
 * Tests cover:
 * - DETECT-02 named regression: May plan with June-spill items overlaps June plan
 * - Two scheduled date-range plans with intersecting item dates overlap
 * - Mixed-type overlap: date-range vs month (DETECT-02 robustness)
 * - Inclusive boundary: plans sharing a single item day overlap
 * - Non-scheduled plans (draft/archived) excluded from check
 * - Same content_plan_id never self-overlaps
 * - A single scheduled plan produces no overlaps
 * - A clean set (distinct clients, non-overlapping intervals) yields empty
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect } from "vitest";
import { detectDupPlans } from "~/lib/dup-plan-detect.js";
import type { ContentPlan } from "~/lib/dup-plan-detect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scheduledMonth(
  content_plan_id: string,
  client_id: string,
  month: number,
  year: number,
  items: string[]
): ContentPlan {
  return {
    content_plan_id,
    client_id,
    status: "scheduled",
    type: "month",
    month,
    year,
    items: items.map((date) => ({ date })),
  };
}

function scheduledRange(
  content_plan_id: string,
  client_id: string,
  start: string,
  end: string,
  items: string[]
): ContentPlan {
  return {
    content_plan_id,
    client_id,
    status: "scheduled",
    type: "date-range",
    start,
    end,
    items: items.map((date) => ({ date })),
  };
}

// ---------------------------------------------------------------------------
// DETECT-02 named regression
// ---------------------------------------------------------------------------

describe("DETECT-02 regression: May plan with June-spill items overlaps June plan", () => {
  it("DETECT-02 regression: May plan with June-spill items overlaps June plan (month=5 vs month=6)", () => {
    const plans: ContentPlan[] = [
      scheduledMonth("may-plan", "bramble", 5, 2026, [
        "2026-05-28",
        "2026-06-01", // spills into June
        "2026-06-03",
      ]),
      scheduledMonth("june-plan", "bramble", 6, 2026, [
        "2026-06-02",
        "2026-06-10",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(1);
    expect(result[0]!.client_id).toBe("bramble");
    expect(result[0]!.plan_id_a).toBe("may-plan");
    expect(result[0]!.plan_id_b).toBe("june-plan");
  });
});

// ---------------------------------------------------------------------------
// Two scheduled date-range plans with intersecting item dates
// ---------------------------------------------------------------------------

describe("date-range plans: intersecting item dates produce an overlap result", () => {
  it("two scheduled date-range plans with overlapping item dates flag the client", () => {
    const plans: ContentPlan[] = [
      scheduledRange("plan-a", "acme", "2026-07-01", "2026-07-31", [
        "2026-07-10",
        "2026-07-20", // same day appears in both plans
      ]),
      scheduledRange("plan-b", "acme", "2026-07-15", "2026-08-15", [
        "2026-07-20", // same day as plan-a item -> direct overlap
        "2026-08-01",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(1);
    expect(result[0]!.client_id).toBe("acme");
    expect(result[0]!.plan_id_a).toBe("plan-a");
    expect(result[0]!.plan_id_b).toBe("plan-b");
  });

  it("two scheduled date-range plans with non-overlapping item dates produce no result", () => {
    const plans: ContentPlan[] = [
      scheduledRange("plan-a", "acme", "2026-07-01", "2026-07-15", [
        "2026-07-05",
        "2026-07-12",
      ]),
      scheduledRange("plan-b", "acme", "2026-07-16", "2026-07-31", [
        "2026-07-20",
        "2026-07-28",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed-type overlap: date-range vs month (DETECT-02 robustness)
// ---------------------------------------------------------------------------

describe("mixed-type overlap (date-range vs month)", () => {
  it("a date-range plan overlapping a month-type plan is flagged (DETECT-02 robustness)", () => {
    const plans: ContentPlan[] = [
      scheduledMonth("aug-plan", "globex", 8, 2026, [
        "2026-08-10",
        "2026-08-20", // same day as summer-plan item -> direct overlap
      ]),
      scheduledRange("summer-plan", "globex", "2026-08-01", "2026-09-30", [
        "2026-08-20", // same day as aug-plan item -> direct overlap
        "2026-09-05",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(1);
    expect(result[0]!.client_id).toBe("globex");
  });
});

// ---------------------------------------------------------------------------
// Inclusive boundary: shared single item day
// ---------------------------------------------------------------------------

describe("inclusive boundary: plans sharing a single item day", () => {
  it("one plan with an item on 2026-06-30 and another with an item on 2026-06-30 overlap (shared day)", () => {
    const plans: ContentPlan[] = [
      scheduledRange("plan-a", "boundary-co", "2026-06-01", "2026-06-30", [
        "2026-06-30",
      ]),
      scheduledRange("plan-b", "boundary-co", "2026-06-30", "2026-07-31", [
        "2026-06-30",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(1);
    expect(result[0]!.client_id).toBe("boundary-co");
  });
});

// ---------------------------------------------------------------------------
// Non-scheduled plans are excluded before the check
// ---------------------------------------------------------------------------

describe("non-scheduled plans are filtered out", () => {
  it("draft and archived plans are excluded and never produce overlaps", () => {
    const plans: ContentPlan[] = [
      {
        content_plan_id: "draft-plan",
        client_id: "test-co",
        status: "draft",
        type: "month",
        month: 6,
        year: 2026,
        items: [{ date: "2026-06-10" }],
      },
      {
        content_plan_id: "archived-plan",
        client_id: "test-co",
        status: "archived",
        type: "month",
        month: 6,
        year: 2026,
        items: [{ date: "2026-06-15" }],
      },
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });

  it("a non-scheduled plan paired with a scheduled plan produces no overlap", () => {
    const plans: ContentPlan[] = [
      scheduledMonth("scheduled-plan", "test-co", 6, 2026, ["2026-06-10"]),
      {
        content_plan_id: "completed-plan",
        client_id: "test-co",
        status: "completed",
        type: "month",
        month: 6,
        year: 2026,
        items: [{ date: "2026-06-10" }],
      },
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Same content_plan_id never self-overlaps
// ---------------------------------------------------------------------------

describe("self-overlap guard: same content_plan_id is never a dup", () => {
  it("two plan objects sharing the same content_plan_id produce no overlap", () => {
    // Edge case: same plan_id with same client - no self-overlap
    const plans: ContentPlan[] = [
      scheduledMonth("same-id", "acme", 6, 2026, ["2026-06-10"]),
      scheduledMonth("same-id", "acme", 6, 2026, ["2026-06-10"]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single scheduled plan produces no overlaps
// ---------------------------------------------------------------------------

describe("single scheduled plan", () => {
  it("a client with only one scheduled plan yields no overlaps", () => {
    const plans: ContentPlan[] = [
      scheduledMonth("only-plan", "solo-co", 7, 2026, ["2026-07-15"]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Clean set: distinct clients, non-overlapping intervals
// ---------------------------------------------------------------------------

describe("clean set: distinct clients and non-overlapping intervals", () => {
  it("distinct clients with no shared interval produce an empty result array", () => {
    const plans: ContentPlan[] = [
      scheduledMonth("client-a-plan", "client-a", 6, 2026, ["2026-06-10"]),
      scheduledMonth("client-b-plan", "client-b", 6, 2026, ["2026-06-15"]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });

  it("same client with non-overlapping date-range plans produces empty result", () => {
    const plans: ContentPlan[] = [
      scheduledRange("q1-plan", "widgets-inc", "2026-01-01", "2026-03-31", [
        "2026-02-15",
      ]),
      scheduledRange("q3-plan", "widgets-inc", "2026-07-01", "2026-09-30", [
        "2026-08-20",
      ]),
    ];

    const result = detectDupPlans(plans);

    expect(result).toHaveLength(0);
  });
});
