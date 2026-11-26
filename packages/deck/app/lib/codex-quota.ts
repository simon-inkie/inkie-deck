/**
 * Pure Codex quota protocol projection and conservative state reducer.
 *
 * The wire shapes mirror Codex 0.153.4. Account identifiers, upsell payloads,
 * and reset-credit records are deliberately absent from the persisted model.
 */

export type QuotaStatus =
  | "UNKNOWN"
  | "BLOCKED_CONFIRMED"
  // Keep the legacy recovery statuses readable from saved snapshots.
  | "RECOVERY_CANDIDATE"
  | "PROBING"
  | "AVAILABLE_CONFIRMED";

export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  /** Unix timestamp in seconds. */
  resetsAt?: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface SpendControlLimitSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: CreditsSnapshot | null;
  individualLimit?: SpendControlLimitSnapshot | null;
  spendControlReached?: boolean | null;
  planType?: string | null;
  rateLimitReachedType?: RateLimitReachedType | null;
}

export interface AccountRateLimits {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export interface QuotaState {
  version: 1;
  quotaContext?: string;
  status: QuotaStatus;
  observedAt: number | null;
  source: "none" | "full_read" | "sparse_update" | "clock" | "probe";
  blockedReason: RateLimitReachedType | "spend_control_reached" | null;
  resetCandidateAt: number | null;
  snapshot: RateLimitSnapshot | null;
}

export type QuotaEvent =
  | { type: "full_read"; payload: AccountRateLimits; observedAt: number }
  | { type: "sparse_update"; payload: RateLimitSnapshot; observedAt: number }
  | { type: "clock"; observedAt: number };

export function initialQuotaState(): QuotaState {
  return {
    version: 1,
    status: "UNKNOWN",
    observedAt: null,
    source: "none",
    blockedReason: null,
    resetCandidateAt: null,
    snapshot: null,
  };
}

function mergeWindow(
  previous: RateLimitWindow | null | undefined,
  update: RateLimitWindow | null | undefined
): RateLimitWindow | null | undefined {
  if (update === null || update === undefined) return previous;
  if (previous === null || previous === undefined) return update;
  return {
    usedPercent: update.usedPercent ?? previous.usedPercent,
    windowDurationMins:
      update.windowDurationMins ?? previous.windowDurationMins,
    resetsAt: update.resetsAt ?? previous.resetsAt,
  };
}

/** Null in a rolling update means unavailable, not clear the known value. */
export function mergeSparseRateLimits(
  previous: RateLimitSnapshot,
  update: RateLimitSnapshot
): RateLimitSnapshot {
  return {
    limitId: update.limitId ?? previous.limitId,
    limitName: update.limitName ?? previous.limitName,
    primary: mergeWindow(previous.primary, update.primary),
    secondary: mergeWindow(previous.secondary, update.secondary),
    credits: update.credits ?? previous.credits,
    individualLimit: update.individualLimit ?? previous.individualLimit,
    spendControlReached:
      update.spendControlReached ?? previous.spendControlReached,
    planType: update.planType ?? previous.planType,
    rateLimitReachedType:
      update.rateLimitReachedType ?? previous.rateLimitReachedType,
  };
}

function selectCodexBucket(payload: AccountRateLimits): RateLimitSnapshot {
  return payload.rateLimitsByLimitId?.["codex"] ?? payload.rateLimits;
}

function blockedReason(
  snapshot: RateLimitSnapshot
): QuotaState["blockedReason"] {
  if (snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined) {
    return snapshot.rateLimitReachedType;
  }
  if (snapshot.spendControlReached === true) return "spend_control_reached";
  return null;
}

function hasExhaustedWindow(snapshot: RateLimitSnapshot): boolean {
  return (
    (snapshot.primary?.usedPercent ?? 0) >= 100 ||
    (snapshot.secondary?.usedPercent ?? 0) >= 100 ||
    (snapshot.individualLimit?.remainingPercent ?? 1) <= 0
  );
}

function isAvailable(
  snapshot: RateLimitSnapshot,
  blockedSnapshot: RateLimitSnapshot | null
): boolean {
  if (hasExhaustedWindow(snapshot)) return false;
  // Availability in a different window cannot clear a known exhausted limit.
  if (
    ((blockedSnapshot?.primary?.usedPercent ?? 0) >= 100 && snapshot.primary?.usedPercent === undefined) ||
    ((blockedSnapshot?.secondary?.usedPercent ?? 0) >= 100 && snapshot.secondary?.usedPercent === undefined) ||
    ((blockedSnapshot?.individualLimit?.remainingPercent ?? 1) <= 0 && snapshot.individualLimit?.remainingPercent === undefined)
  ) {
    return false;
  }
  return (
    snapshot.spendControlReached === false ||
    snapshot.rateLimitReachedType === null ||
    snapshot.credits?.unlimited === true ||
    snapshot.credits?.hasCredits === true ||
    (snapshot.primary?.usedPercent !== undefined &&
      snapshot.primary.usedPercent < 100) ||
    (snapshot.secondary?.usedPercent !== undefined &&
      snapshot.secondary.usedPercent < 100) ||
    (snapshot.individualLimit?.remainingPercent !== undefined &&
      snapshot.individualLimit.remainingPercent > 0)
  );
}

function resetCandidateAt(snapshot: RateLimitSnapshot): number | null {
  const exhausted = [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow =>
      window !== null &&
      window !== undefined &&
      (window.usedPercent ?? 0) >= 100 &&
      window.resetsAt !== null &&
      window.resetsAt !== undefined
    )
    .map((window) => window.resetsAt! * 1_000);
  if (
    snapshot.individualLimit !== null &&
    snapshot.individualLimit !== undefined &&
    snapshot.individualLimit.remainingPercent <= 0
  ) {
    exhausted.push(snapshot.individualLimit.resetsAt * 1_000);
  }
  if (exhausted.length > 0) return Math.max(...exhausted);

  const known = [snapshot.primary?.resetsAt, snapshot.secondary?.resetsAt]
    .filter((value): value is number => value !== null && value !== undefined)
    .map((value) => value * 1_000);
  return known.length > 0 ? Math.max(...known) : null;
}

function advanceResetClock(state: QuotaState, now: number): QuotaState {
  if (
    state.status === "BLOCKED_CONFIRMED" &&
    state.resetCandidateAt !== null &&
    now >= state.resetCandidateAt
  ) {
    return { ...state, status: "UNKNOWN", blockedReason: null, resetCandidateAt: null };
  }
  return state;
}

export function reduceQuotaState(
  previous: QuotaState,
  event: QuotaEvent
): QuotaState {
  if (event.type === "clock") return advanceResetClock(previous, event.observedAt);

  const incoming = event.type === "full_read" ? selectCodexBucket(event.payload) : event.payload;
  const reason = blockedReason(incoming);
  const wasBlocked = previous.status === "BLOCKED_CONFIRMED";
  if (event.type === "sparse_update" && wasBlocked && reason === null) {
    return advanceResetClock(previous, event.observedAt);
  }
  const snapshot =
    event.type === "sparse_update" && previous.snapshot !== null
      ? mergeSparseRateLimits(previous.snapshot, incoming)
      : incoming;
  const withSnapshot = { ...previous, snapshot, observedAt: event.observedAt, source: event.type };
  if (reason !== null) {
    const resetAt = resetCandidateAt(snapshot);
    // A fresh sparse block may omit its reset while the merged snapshot still
    // contains an expired reset from the previous block.
    const mayHaveInheritedExpiredReset = event.type === "sparse_update" &&
      resetAt !== null && resetAt <= event.observedAt;
    return {
      ...withSnapshot,
      status: "BLOCKED_CONFIRMED",
      blockedReason: reason,
      resetCandidateAt: mayHaveInheritedExpiredReset ? resetCandidateAt(incoming) : resetAt,
    };
  }

  if (event.type === "sparse_update") {
    return hasExhaustedWindow(snapshot)
      ? { ...withSnapshot, status: "UNKNOWN" }
      : withSnapshot;
  }

  const available = isAvailable(snapshot, wasBlocked ? previous.snapshot : null);
  if (wasBlocked && !available) return advanceResetClock(previous, event.observedAt);

  return {
    ...withSnapshot,
    status: available ? "AVAILABLE_CONFIRMED" : "UNKNOWN",
    blockedReason: null,
    resetCandidateAt: null,
  };
}
