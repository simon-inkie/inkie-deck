/**
 * Pure Codex quota protocol projection and conservative state reducer.
 *
 * The wire shapes mirror Codex 0.153.4. Account identifiers, upsell payloads,
 * and reset-credit records are deliberately absent from the persisted model.
 */

export type QuotaStatus =
  | "UNKNOWN"
  | "BLOCKED_CONFIRMED"
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
  | { type: "clock"; observedAt: number }
  | { type: "probe_started"; observedAt: number }
  | { type: "probe_succeeded"; observedAt: number }
  | { type: "probe_failed"; observedAt: number };

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

function hasAvailableEvidence(snapshot: RateLimitSnapshot): boolean {
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

function blockedState(
  previous: QuotaState,
  snapshot: RateLimitSnapshot,
  observedAt: number,
  source: QuotaState["source"]
): QuotaState {
  return {
    ...previous,
    status: "BLOCKED_CONFIRMED",
    observedAt,
    source,
    blockedReason: blockedReason(snapshot),
    resetCandidateAt: resetCandidateAt(snapshot),
    snapshot,
  };
}

function advanceResetClock(state: QuotaState, observedAt: number): QuotaState {
  if (
    state.status === "BLOCKED_CONFIRMED" &&
    state.resetCandidateAt !== null &&
    observedAt >= state.resetCandidateAt
  ) {
    return { ...state, status: "RECOVERY_CANDIDATE", observedAt, source: "clock" };
  }
  return { ...state, observedAt, source: "clock" };
}

export function reduceQuotaState(
  previous: QuotaState,
  event: QuotaEvent
): QuotaState {
  if (event.type === "clock") return advanceResetClock(previous, event.observedAt);

  if (event.type === "probe_started") {
    if (previous.status !== "RECOVERY_CANDIDATE") return previous;
    return { ...previous, status: "PROBING", observedAt: event.observedAt, source: "probe" };
  }
  if (event.type === "probe_succeeded") {
    if (previous.status !== "PROBING") return previous;
    return {
      ...previous,
      status: "AVAILABLE_CONFIRMED",
      observedAt: event.observedAt,
      source: "probe",
      blockedReason: null,
      resetCandidateAt: null,
    };
  }
  if (event.type === "probe_failed") {
    if (previous.status !== "PROBING") return previous;
    return {
      ...previous,
      status: "BLOCKED_CONFIRMED",
      observedAt: event.observedAt,
      source: "probe",
    };
  }

  const source = event.type;
  const snapshot =
    event.type === "full_read"
      ? selectCodexBucket(event.payload)
      : previous.snapshot === null
        ? event.payload
        : mergeSparseRateLimits(previous.snapshot, event.payload);
  if (blockedReason(snapshot) !== null) {
    return blockedState(previous, snapshot, event.observedAt, source);
  }

  if (event.type === "sparse_update") {
    const withSnapshot = { ...previous, snapshot, observedAt: event.observedAt, source };
    if (previous.status === "BLOCKED_CONFIRMED") {
      return withSnapshot;
    }
    if (
      previous.status === "RECOVERY_CANDIDATE" ||
      previous.status === "PROBING"
    ) {
      return withSnapshot;
    }
    return hasExhaustedWindow(snapshot)
      ? { ...withSnapshot, status: "UNKNOWN" }
      : withSnapshot;
  }

  if (
    previous.status === "BLOCKED_CONFIRMED" ||
    previous.status === "RECOVERY_CANDIDATE" ||
    previous.status === "PROBING"
  ) {
    if (!hasAvailableEvidence(snapshot)) {
      return { ...previous, observedAt: event.observedAt, source, snapshot };
    }
    return {
      ...previous,
      status: "RECOVERY_CANDIDATE",
      observedAt: event.observedAt,
      source,
      snapshot,
    };
  }

  return {
    ...previous,
    status:
      hasExhaustedWindow(snapshot) || !hasAvailableEvidence(snapshot)
        ? "UNKNOWN"
        : "AVAILABLE_CONFIRMED",
    observedAt: event.observedAt,
    source,
    blockedReason: null,
    resetCandidateAt: null,
    snapshot,
  };
}
