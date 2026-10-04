import { describe, expect, it } from "vitest";
import {
  buildCodexQuotaDisplay,
  type QuotaSnapshotRead,
} from "~/lib/codex-quota-display";
import type { QuotaState } from "~/lib/codex-quota";

const NOW = Date.parse("2026-09-16T08:00:00Z");

function state(over: Partial<QuotaState> = {}): QuotaState {
  return {
    version: 1,
    status: "AVAILABLE_CONFIRMED",
    observedAt: NOW - 60_000,
    source: "full_read",
    blockedReason: null,
    resetCandidateAt: null,
    snapshot: {
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_789_545_600 },
      secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: 1_790_236_800 },
      spendControlReached: false,
      rateLimitReachedType: null,
    },
    ...over,
  };
}

describe("Codex quota display view-model", () => {
  it.each([
    [{ kind: "missing" } satisfies QuotaSnapshotRead, "missing"],
    [{ kind: "malformed" } satisfies QuotaSnapshotRead, "malformed"],
  ])("keeps %s evidence unavailable rather than inventing availability", (read, reason) => {
    const view = buildCodexQuotaDisplay(read, NOW, 15 * 60_000);
    expect(view.freshness).toBe(reason);
    expect(view.status).toBe("UNKNOWN");
    expect(view.windows).toEqual([]);
    expect(view.available).toBe(false);
  });

  it("labels the real five-hour and seven-day buckets from windowDurationMins", () => {
    const view = buildCodexQuotaDisplay({ kind: "ok", state: state() }, NOW, 15 * 60_000);
    expect(view.windows).toEqual([
      expect.objectContaining({ key: "primary", label: "5-hour", usedPercent: 42 }),
      expect.objectContaining({ key: "secondary", label: "7-day", usedPercent: 71 }),
    ]);
    expect(view.windows[0]!.resetAt).toBe("2026-09-16T08:00:00.000Z");
  });

  it("uses an honest duration label for a non-standard bucket", () => {
    const custom = state({
      snapshot: { primary: { usedPercent: 12, windowDurationMins: 90, resetsAt: null } },
    });
    const view = buildCodexQuotaDisplay({ kind: "ok", state: custom }, NOW, 15 * 60_000);
    expect(view.windows[0]!.label).toBe("90-minute");
    expect(view.windows[0]!.resetAt).toBeNull();
  });

  it("marks old evidence stale without clearing its last-known blocked warning", () => {
    const blocked = state({
      status: "BLOCKED_CONFIRMED",
      observedAt: NOW - 16 * 60_000,
      blockedReason: "spend_control_reached",
      snapshot: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        spendControlReached: true,
      },
    });
    const view = buildCodexQuotaDisplay({ kind: "ok", state: blocked }, NOW, 15 * 60_000);
    expect(view.freshness).toBe("stale");
    expect(view.blocked).toBe(true);
    expect(view.warning).toContain("Spend control reached");
    expect(view.warning).toContain("stale");
    expect(view.available).toBe(false);
  });

  it("does not turn protocol UNKNOWN into an available claim even with percentages", () => {
    const unknown = state({ status: "UNKNOWN" });
    const view = buildCodexQuotaDisplay({ kind: "ok", state: unknown }, NOW, 15 * 60_000);
    expect(view.status).toBe("UNKNOWN");
    expect(view.available).toBe(false);
    expect(view.windows).toHaveLength(2);
  });

  it("drops impossible percentages instead of drawing a misleading bar", () => {
    const invalid = state({
      snapshot: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } },
    });
    const view = buildCodexQuotaDisplay({ kind: "ok", state: invalid }, NOW, 15 * 60_000);
    expect(view.windows).toEqual([]);
  });
});
