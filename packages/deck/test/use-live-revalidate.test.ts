/**
 * use-live-revalidate.test.ts - poll-guard truth table.
 *
 * The interval wiring is trivial-by-inspection (node test env, no jsdom);
 * the GUARD is the logic, extracted pure as shouldPoll.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect } from "vitest";
import {
  shouldPoll,
  LIVE_REVALIDATE_INTERVAL_MS,
} from "~/lib/use-live-revalidate";

describe("shouldPoll - the TASK-455 poll guard", () => {
  it("polls when visible and idle", () => {
    expect(shouldPoll(false, "idle")).toBe(true);
  });

  it("never polls a hidden tab", () => {
    expect(shouldPoll(true, "idle")).toBe(false);
  });

  it("never overlaps a running revalidation", () => {
    expect(shouldPoll(false, "loading")).toBe(false);
  });

  it("hidden AND busy stays paused", () => {
    expect(shouldPoll(true, "loading")).toBe(false);
  });
});

describe("LIVE_REVALIDATE_INTERVAL_MS", () => {
  it("sits inside the ticketed 2-5s band", () => {
    expect(LIVE_REVALIDATE_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
    expect(LIVE_REVALIDATE_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });
});
