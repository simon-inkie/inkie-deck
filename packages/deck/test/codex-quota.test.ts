import { describe, expect, it } from "vitest";
import {
  initialQuotaState,
  mergeSparseRateLimits,
  reduceQuotaState,
  type AccountRateLimits,
  type RateLimitSnapshot,
} from "../app/lib/codex-quota";

const available: RateLimitSnapshot = {
  limitId: "codex",
  limitName: "Codex",
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000 },
  secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 8_000 },
  credits: { hasCredits: true, unlimited: false, balance: "12" },
  individualLimit: null,
  spendControlReached: false,
  planType: "plus",
  rateLimitReachedType: null,
};

const full = (rateLimits: RateLimitSnapshot): AccountRateLimits => ({
  rateLimits,
  rateLimitsByLimitId: { codex: rateLimits },
});

describe("Codex quota reducer", () => {
  it("confirms availability from a fresh full read with positive evidence", () => {
    const state = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full(available),
      observedAt: 1_000_000,
    });

    expect(state.status).toBe("AVAILABLE_CONFIRMED");
    expect(state.source).toBe("full_read");
  });

  it("confirms blocked only from explicit backend evidence", () => {
    const state = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, rateLimitReachedType: "rate_limit_reached" }),
      observedAt: 1_000_000,
    });

    expect(state.status).toBe("BLOCKED_CONFIRMED");
    expect(state.blockedReason).toBe("rate_limit_reached");
  });

  it("treats spend-control reached as explicit blocked evidence", () => {
    const state = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, spendControlReached: true }),
      observedAt: 1_000_000,
    });

    expect(state.status).toBe("BLOCKED_CONFIRMED");
    expect(state.blockedReason).toBe("spend_control_reached");
    expect(state.resetCandidateAt).toBeNull();
    expect(reduceQuotaState(state, { type: "clock", observedAt: 8_000_000 })).toBe(state);
  });

  it("selects the exhausted spend limit's reset even when another exhausted window resets later", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        ...available,
        secondary: { usedPercent: 100, resetsAt: 8_000 },
        individualLimit: { limit: "12", used: "12", remainingPercent: 0, resetsAt: 3_000 },
        spendControlReached: true,
      }),
      observedAt: 1_000_000,
    });

    expect(blocked.resetCandidateAt).toBe(3_000_000);
    expect(reduceQuotaState(blocked, { type: "clock", observedAt: 3_000_000 }).status).toBe("UNKNOWN");
  });

  it("does not treat 100 percent usage alone as confirmed blocked", () => {
    const state = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        ...available,
        primary: { ...available.primary!, usedPercent: 100 },
      }),
      observedAt: 1_000_000,
    });

    expect(state.status).toBe("UNKNOWN");
  });

  it("merges nullable sparse values without erasing known account metadata", () => {
    const merged = mergeSparseRateLimits(available, {
      ...available,
      limitName: null,
      credits: null,
      planType: null,
      primary: { usedPercent: 60, windowDurationMins: null, resetsAt: null },
    });

    expect(merged.limitName).toBe("Codex");
    expect(merged.credits).toEqual(available.credits);
    expect(merged.planType).toBe("plus");
    expect(merged.primary).toEqual({
      usedPercent: 60,
      windowDurationMins: 300,
      resetsAt: 2_000,
    });
  });

  it("handles omitted 0.153.4 snapshot properties conservatively", () => {
    const merged = mergeSparseRateLimits(available, {
      primary: { usedPercent: 61 },
    });

    expect(merged.limitName).toBe("Codex");
    expect(merged.rateLimitReachedType).toBeNull();
    expect(merged.primary).toEqual({
      usedPercent: 61,
      windowDurationMins: 300,
      resetsAt: 2_000,
    });

    const state = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: { rateLimits: {} },
      observedAt: 1_000_000,
    });
    expect(state.status).toBe("UNKNOWN");
  });

  it("preserves the confirmed block and its observation on an available sparse update", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, rateLimitReachedType: "rate_limit_reached" }),
      observedAt: 1_000_000,
    });
    const afterSparse = reduceQuotaState(blocked, {
      type: "sparse_update",
      payload: { ...available, rateLimitReachedType: null },
      observedAt: 1_100_000,
    });

    expect(afterSparse).toBe(blocked);
  });

  it("ignores a sparse update at 100 percent without explicit block evidence", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, rateLimitReachedType: "rate_limit_reached" }),
      observedAt: 1_000_000,
    });
    const afterSparse = reduceQuotaState(blocked, {
      type: "sparse_update",
      payload: {
        primary: { usedPercent: 100, resetsAt: 1_200 },
      },
      observedAt: 1_100_000,
    });

    expect(afterSparse).toBe(blocked);
  });

  it("records a fresh block when a sparse update explicitly reports one", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, rateLimitReachedType: "rate_limit_reached" }),
      observedAt: 1_000_000,
    });

    expect(reduceQuotaState(blocked, {
      type: "sparse_update",
      payload: { spendControlReached: true },
      observedAt: 1_100_000,
    })).toMatchObject({
      status: "BLOCKED_CONFIRMED",
      blockedReason: "spend_control_reached",
      observedAt: 1_100_000,
      source: "sparse_update",
    });
  });

  it("moves a blocked state to unknown at its reset time", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        ...available,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000 },
        rateLimitReachedType: "rate_limit_reached",
      }),
      observedAt: 1_000_000,
    });

    const before = reduceQuotaState(blocked, {
      type: "clock",
      observedAt: 1_999_000,
    });
    const after = reduceQuotaState(before, {
      type: "clock",
      observedAt: 2_000_000,
    });

    expect(before).toBe(blocked);
    expect(after).toMatchObject({ status: "UNKNOWN", observedAt: blocked.observedAt });
    expect(reduceQuotaState(blocked, {
      type: "full_read",
      payload: full({}),
      observedAt: 2_000_000,
    })).toEqual(after);
  });

  it("does not carry an expired reset into a fresh explicit sparse block", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        primary: { usedPercent: 100, resetsAt: 2_000 },
        rateLimitReachedType: "rate_limit_reached",
      }),
      observedAt: 1_000_000,
    });

    expect(reduceQuotaState(blocked, {
      type: "sparse_update",
      payload: { spendControlReached: true },
      observedAt: 2_100_000,
    })).toMatchObject({
      status: "BLOCKED_CONFIRMED",
      blockedReason: "spend_control_reached",
      resetCandidateAt: null,
    });
  });

  it("preserves a block through inconclusive full reads and recovers on one clean full read", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        ...available,
        secondary: { usedPercent: 100, resetsAt: 2_000 },
        rateLimitReachedType: "rate_limit_reached",
      }),
      observedAt: 1_000_000,
    });
    const read = (snapshot: RateLimitSnapshot) => reduceQuotaState(blocked, {
      type: "full_read",
      payload: full(snapshot),
      observedAt: 1_500_000,
    });

    expect(read({ primary: { usedPercent: 80 }, spendControlReached: false })).toBe(blocked);
    expect(read({})).toBe(blocked);
    expect(read({ secondary: { usedPercent: 40 }, rateLimitReachedType: null })).toBe(blocked);
    expect(read({ secondary: { usedPercent: 100, resetsAt: 3_000 }, spendControlReached: false })).toBe(blocked);
    expect(read(available)).toMatchObject({
      status: "AVAILABLE_CONFIRMED",
      blockedReason: null,
      resetCandidateAt: null,
      observedAt: 1_500_000,
    });
  });

  it("records a renewed spend block after a clean full read cleared the previous block", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({
        ...available,
        spendControlReached: true,
        individualLimit: { limit: "12", used: "12", remainingPercent: 0, resetsAt: 3_000 },
      }),
      observedAt: 1_000_000,
    });
    expect(blocked).toMatchObject({
      status: "BLOCKED_CONFIRMED",
      resetCandidateAt: 3_000_000,
    });

    const cleared = reduceQuotaState(blocked, {
      type: "full_read",
      payload: full({
        ...available,
        individualLimit: { limit: "12", used: "6", remainingPercent: 50, resetsAt: 3_000 },
      }),
      observedAt: 1_100_000,
    });
    expect(cleared).toMatchObject({ status: "AVAILABLE_CONFIRMED", blockedReason: null });

    const renewed = reduceQuotaState(cleared, {
      type: "sparse_update",
      payload: { spendControlReached: true },
      observedAt: 1_200_000,
    });
    expect(renewed).toMatchObject({
      status: "BLOCKED_CONFIRMED",
      blockedReason: "spend_control_reached",
      resetCandidateAt: null,
      observedAt: 1_200_000,
    });
    expect(reduceQuotaState(renewed, { type: "clock", observedAt: 3_000_000 })).toBe(renewed);
  });
});
