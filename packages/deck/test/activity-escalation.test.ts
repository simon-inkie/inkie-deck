/**
 * test/activity-escalation.test.ts - `escalatedAgents`, the top-bar
 * escalation's pure function (top-bar escalation SPEC, the consumer half).
 *
 * Mirrors activity.test.ts's MC_NOW-injection style: every clock is passed
 * in, nothing here reads the wall clock. Weighted towards the threshold
 * boundary (just under / at / just over) since a duration comparison is
 * exactly where an off-by-one hides, and towards the missing-`statusSince`
 * degrade path, since a sweep older than that producer field writes documents
 * with no `statusSince` on any record at all.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, vi } from "vitest";
import {
  escalatedAgents,
  parseActivityDocument,
  type AgentActivity,
} from "~/lib/activity.shared";
import {
  ESCALATION_THRESHOLD_MS,
  resolveEscalationThresholdMs,
} from "~/lib/activity.server";

const NOW = new Date("2026-08-14T12:00:00Z");
const THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes, the SPEC's proposed default

/** A minimal, valid AgentActivity row - override only what a case cares about. */
function agent(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    agent: "summit",
    status: "stuck",
    signal: "stuck-shape",
    evidence: "pane tail matches a permission dialog literal",
    busy: false,
    idleMinutes: 12,
    worktree: null,
    recent: [],
    updated: "2026-08-14T11:00:00Z",
    subagentCount: null,
    inference: null,
    ...over,
  };
}

describe("escalatedAgents", () => {
  // -------------------------------------------------------------------------
  // Threshold boundary - just under / at / just over
  // -------------------------------------------------------------------------

  it("does not escalate an agent just UNDER the threshold", () => {
    const statusSince = new Date(NOW.getTime() - (THRESHOLD_MS - 1)).toISOString();
    const out = escalatedAgents([agent({ statusSince })], NOW, THRESHOLD_MS);
    expect(out).toEqual([]);
  });

  it("escalates an agent exactly AT the threshold (inclusive boundary)", () => {
    const statusSince = new Date(NOW.getTime() - THRESHOLD_MS).toISOString();
    const out = escalatedAgents([agent({ statusSince })], NOW, THRESHOLD_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      agent: "summit",
      status: "stuck",
      statusSince,
      durationMs: THRESHOLD_MS,
    });
  });

  it("escalates an agent just OVER the threshold", () => {
    const statusSince = new Date(NOW.getTime() - (THRESHOLD_MS + 1)).toISOString();
    const out = escalatedAgents([agent({ statusSince })], NOW, THRESHOLD_MS);
    expect(out).toHaveLength(1);
    expect(out[0]!.durationMs).toBe(THRESHOLD_MS + 1);
  });

  // -------------------------------------------------------------------------
  // Status filtering
  // -------------------------------------------------------------------------

  it("includes stuck and needs-you once past the threshold", () => {
    const statusSince = new Date(NOW.getTime() - THRESHOLD_MS - 1000).toISOString();
    const out = escalatedAgents(
      [
        agent({ agent: "quill", status: "stuck", statusSince }),
        agent({ agent: "scribe", status: "needs-you", statusSince }),
      ],
      NOW,
      THRESHOLD_MS
    );
    expect(out.map((e) => e.agent).sort()).toEqual(["quill", "scribe"]);
  });

  it("excludes waiting-on-teammate, waiting-on-machine, working, done-for-now and unknown, however long they have sat", () => {
    const statusSince = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString(); // 10h, well past
    const out = escalatedAgents(
      [
        agent({ agent: "a", status: "waiting-on-teammate", statusSince }),
        agent({ agent: "b", status: "waiting-on-machine", statusSince }),
        agent({ agent: "c", status: "working", statusSince }),
        agent({ agent: "d", status: "done-for-now", statusSince }),
        agent({ agent: "e", status: "unknown", statusSince }),
      ],
      NOW,
      THRESHOLD_MS
    );
    expect(out).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Missing statusSince degrade
  //
  // Caught in review: the original degrade fell back to `updated` (the
  // sweep-tick write time), reasoning it as "just entered this status" since
  // updated is usually only seconds old. That reasoning only holds while the
  // sweep is healthy. If the sweep itself goes stale (cron misconfigured, box
  // down - exactly the kind of failure this feature exists to catch),
  // `updated` stops advancing and the gap between it and `now` grows
  // unboundedly, producing a FALSE escalation from data staleness rather than
  // a real wedged agent - the opposite of what an alert should do at the exact
  // moment its own inputs are unreliable. Fixed: no fallback. Missing
  // statusSince means "cannot compute duration", full stop, not "assume it
  // just started."
  // -------------------------------------------------------------------------

  it("a missing statusSince never escalates - no fallback to `updated`, however old", () => {
    // updated is deliberately far past the threshold; this must NOT escalate.
    const updated = new Date(NOW.getTime() - THRESHOLD_MS - 1000).toISOString();
    const out = escalatedAgents(
      [agent({ status: "stuck", statusSince: undefined, updated })],
      NOW,
      THRESHOLD_MS
    );
    expect(out).toEqual([]);
  });

  it("both statusSince and updated absent: no timestamp to compare, so no throw and no escalation", () => {
    const out = escalatedAgents(
      [agent({ status: "stuck", statusSince: undefined, updated: null })],
      NOW,
      THRESHOLD_MS
    );
    expect(out).toEqual([]);
  });

  it("an unparseable statusSince degrades to skipped, not a throw or a NaN duration", () => {
    const out = escalatedAgents(
      [agent({ status: "stuck", statusSince: "not-a-date", updated: "2026-08-14T11:00:00Z" })],
      NOW,
      THRESHOLD_MS
    );
    expect(out).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  it("an empty agents list escalates nothing", () => {
    expect(escalatedAgents([], NOW, THRESHOLD_MS)).toEqual([]);
  });

  it("real statusSince takes priority over updated when both are present", () => {
    const staleUpdated = new Date(NOW.getTime() - 1000).toISOString(); // 1s ago
    const oldStatusSince = new Date(NOW.getTime() - THRESHOLD_MS - 1000).toISOString();
    const out = escalatedAgents(
      [agent({ status: "stuck", statusSince: oldStatusSince, updated: staleUpdated })],
      NOW,
      THRESHOLD_MS
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.statusSince).toBe(oldStatusSince);
  });
});

// ---------------------------------------------------------------------------

describe("resolveEscalationThresholdMs", () => {
  it("returns the default when the variable is unset or blank", () => {
    expect(resolveEscalationThresholdMs({})).toBe(ESCALATION_THRESHOLD_MS);
    expect(resolveEscalationThresholdMs({ ESCALATION_THRESHOLD_MS: "   " })).toBe(
      ESCALATION_THRESHOLD_MS
    );
  });

  it("honours a positive numeric override, whitespace and all", () => {
    expect(resolveEscalationThresholdMs({ ESCALATION_THRESHOLD_MS: " 60000 " })).toBe(60000);
  });

  it("degrades to the default on garbage rather than escalating everything or nothing", () => {
    // 0 would escalate every stuck agent instantly; NaN would compare false
    // against every duration and escalate nothing, silently. Both are worse
    // than ignoring the override, so both fall back - loudly, via warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
        expect(resolveEscalationThresholdMs({ ESCALATION_THRESHOLD_MS: bad })).toBe(
          ESCALATION_THRESHOLD_MS
        );
      }
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------

describe("parseActivityDocument - statusSince", () => {
  function doc(agentRecord: Record<string, unknown>): string {
    return JSON.stringify({
      schema: 1,
      swept: "2026-08-14T12:00:00Z",
      agents: { summit: { status: "stuck", ...agentRecord } },
    });
  }

  it("carries a string statusSince through from the wire", () => {
    const parsed = parseActivityDocument(doc({ statusSince: "2026-08-14T11:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.agents[0]!.statusSince).toBe("2026-08-14T11:00:00Z");
  });

  it("leaves the property genuinely ABSENT when the producer omits it", () => {
    // Not `null`: `escalatedAgents` tests `=== undefined`, and a stored null
    // would sail past that check and reach `new Date(null)`, which is the
    // epoch and therefore an escalation of about 56 years.
    const parsed = parseActivityDocument(doc({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.agents[0]!.statusSince).toBeUndefined();
  });

  it("drops a non-string statusSince instead of carrying it", () => {
    const parsed = parseActivityDocument(doc({ statusSince: 1_755_000_000_000 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.agents[0]!.statusSince).toBeUndefined();
  });
});
