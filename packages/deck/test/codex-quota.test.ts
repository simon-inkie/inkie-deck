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

  it("never clears a confirmed block from a sparse update", () => {
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

    expect(afterSparse.status).toBe("BLOCKED_CONFIRMED");
    expect(afterSparse.blockedReason).toBe("rate_limit_reached");
  });

  it("does not leave a confirmed block on sparse reset evidence", () => {
    const blocked = reduceQuotaState(initialQuotaState(), {
      type: "full_read",
      payload: full({ ...available, rateLimitReachedType: "rate_limit_reached" }),
      observedAt: 1_000_000,
    });
    const afterSparse = reduceQuotaState(blocked, {
      type: "sparse_update",
      payload: {
        primary: { usedPercent: 0, resetsAt: 900 },
        rateLimitReachedType: null,
      },
      observedAt: 1_100_000,
    });

    expect(afterSparse.status).toBe("BLOCKED_CONFIRMED");
  });

  it("moves a blocked state to recovery candidacy only after its reset", () => {
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

    expect(before.status).toBe("BLOCKED_CONFIRMED");
    expect(after.status).toBe("RECOVERY_CANDIDATE");
  });

  it("requires two available full reads after a clock reset or inconclusive read", () => {
    let state = initialQuotaState();
    const read = (snapshot: RateLimitSnapshot) => {
      state = reduceQuotaState(state, {
        type: "full_read",
        payload: full(snapshot),
        observedAt: 2_000_000,
      });
    };
    read({ primary: { usedPercent: 100, resetsAt: 2_000 }, spendControlReached: true });
    state = reduceQuotaState(state, { type: "clock", observedAt: 2_000_000 });
    state = reduceQuotaState(state, {
      type: "sparse_update",
      payload: { primary: { usedPercent: 80 }, spendControlReached: false },
      observedAt: 2_000_000,
    });
    read(available);
    expect(state.status).toBe("RECOVERY_CANDIDATE");
    read({});
    expect(state.status).toBe("BLOCKED_CONFIRMED");
    read(available);
    expect(state.status).toBe("RECOVERY_CANDIDATE");
    read(available);
    expect(state.status).toBe("AVAILABLE_CONFIRMED");
  });

  it("confirms recovery after a successful probe", () => {
    const candidate = {
      ...initialQuotaState(),
      status: "RECOVERY_CANDIDATE" as const,
      snapshot: available,
    };
    const probing = reduceQuotaState(candidate, {
      type: "probe_started",
      observedAt: 2_100_000,
    });
    const recovered = reduceQuotaState(probing, {
      type: "probe_succeeded",
      observedAt: 2_200_000,
    });

    expect(probing.status).toBe("PROBING");
    expect(recovered.status).toBe("AVAILABLE_CONFIRMED");
  });
});
