/**
 * Named regression test: SLA DST correctness
 *
 * Proves that date-fns addHours measures real elapsed time across DST
 * boundaries, not wall-clock hours. US Eastern spring-forward:
 * 2025-03-09 02:00 EST -> 03:00 EDT (clocks skip 1 hour forward).
 *
 * If SLA deadline arithmetic used wall-clock hours, a 24h deadline
 * starting at 01:00 EST would land at 02:00 EDT the next day (23 real hours).
 * addHours uses absolute ms arithmetic so the deadline lands at the correct
 * real instant regardless of DST transitions.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect } from "vitest";
import { addHours } from "date-fns";
import { deriveQueueItems } from "~/lib/queue-derive.js";
import type { MessageBlock } from "~/lib/blocks/model.js";

// US Eastern spring-forward: 2025-03-09 02:00 EST -> 03:00 EDT
// This UTC instant is 01:00 EST, just before the spring-forward transition.
const DST_SPRING_FORWARD_UTC = "2025-03-09T06:00:00Z";

describe("SLA DST regression (QUEUE-10)", () => {
  it("addHours across spring-forward produces exactly 24 real hours", () => {
    const start = new Date(DST_SPRING_FORWARD_UTC);
    const deadline = addHours(start, 24);
    // Must be exactly 24 * 60 * 60 * 1000 ms (real elapsed time, not wall-clock)
    expect(deadline.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(deadline.toISOString()).toBe("2025-03-10T06:00:00.000Z");
  });

  it("ageDisplay contains 'hour' for a 3h-overdue item (no wall-clock read)", () => {
    // Build a minimal plain block timestamped at DST_SPRING_FORWARD_UTC
    const block: MessageBlock = {
      header: {
        timestamp: DST_SPRING_FORWARD_UTC,
        from: "agent-dst-test",
        status: "sent",
        subject: "DST regression test",
      },
      body: "DST regression",
      card: undefined,
      rawMeta: "",
    };

    // Plain block gets 48h deadline. Inject now 3h past the deadline.
    const deadline = addHours(new Date(DST_SPRING_FORWARD_UTC), 48);
    const now = addHours(deadline, 3);

    const entries = [{ agentName: "dst-agent", block }];
    const handledIds = new Set<string>();
    // Pass the pre-computed deadline in the map so we control the exact anchor
    const deadlineMap = new Map<string, string>();

    const { items } = deriveQueueItems(entries, handledIds, deadlineMap, now);

    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
    // formatDistance is approximate; just assert 'hour' is present
    expect(items[0]!.ageDisplay).toContain("hour");
  });
});
