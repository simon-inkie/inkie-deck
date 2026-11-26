import { reduceQuotaState, type QuotaState, type QuotaStatus, type RateLimitWindow } from "./codex-quota";

export type QuotaSnapshotRead =
  | { kind: "ok"; state: QuotaState }
  | { kind: "missing" }
  | { kind: "malformed" };

export type QuotaFreshness = "fresh" | "stale" | "missing" | "malformed";
export type CodexProvider = "plus" | "azure" | "unknown";

export interface QuotaWindowView {
  key: "primary" | "secondary";
  label: string;
  usedPercent: number;
  resetAt: string | null;
}

export interface CodexQuotaView {
  freshness: QuotaFreshness;
  status: QuotaStatus;
  available: boolean;
  blocked: boolean;
  warning: string | null;
  observedAt: string | null;
  windows: QuotaWindowView[];
}

export interface CodexQuotaDisplayData {
  quota: CodexQuotaView;
  providers: Record<string, CodexProvider>;
}

function durationLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "7-day";
  if (minutes === null || minutes === undefined || minutes <= 0) return "Unknown window";
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days}-day`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour`;
  }
  return `${minutes}-minute`;
}

function safeIsoString(ms: number): string | null {
  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function windowView(
  key: "primary" | "secondary",
  value: RateLimitWindow | null | undefined
): QuotaWindowView | null {
  const used = value?.usedPercent;
  if (used === undefined || !Number.isFinite(used) || used < 0 || used > 100) {
    return null;
  }
  const reset = value?.resetsAt;
  return {
    key,
    label: durationLabel(value?.windowDurationMins),
    usedPercent: used,
    resetAt:
      reset === null || reset === undefined || !Number.isFinite(reset)
        ? null
        : safeIsoString(reset * 1_000),
  };
}

function warningFor(state: QuotaState, stale: boolean): string | null {
  let warning: string | null = null;
  if (state.blockedReason === "spend_control_reached") {
    warning = "Spend control reached.";
  } else if (state.blockedReason !== null) {
    warning = "ChatGPT Plus quota is blocked.";
  } else if (state.status === "BLOCKED_CONFIRMED") {
    warning = "ChatGPT Plus quota is blocked.";
  }
  if (warning !== null && stale) return `${warning} Evidence is stale.`;
  return warning;
}

export function buildCodexQuotaDisplay(
  read: QuotaSnapshotRead,
  now: number,
  staleAfterMs: number
): CodexQuotaView {
  if (read.kind !== "ok") {
    return {
      freshness: read.kind,
      status: "UNKNOWN",
      available: false,
      blocked: false,
      warning: null,
      observedAt: null,
      windows: [],
    };
  }

  const state = reduceQuotaState(read.state, { type: "clock", observedAt: now });
  const observedAt = state.observedAt;
  const stale =
    observedAt === null ||
    !Number.isFinite(observedAt) ||
    now - observedAt > staleAfterMs;
  const windows = [
    windowView("primary", state.snapshot?.primary),
    windowView("secondary", state.snapshot?.secondary),
  ].filter((window): window is QuotaWindowView => window !== null);
  const blocked = state.status === "BLOCKED_CONFIRMED";

  return {
    freshness: stale ? "stale" : "fresh",
    status: state.status,
    available: state.status === "AVAILABLE_CONFIRMED" && !stale,
    blocked,
    warning: warningFor(state, stale),
    observedAt:
      observedAt === null || !Number.isFinite(observedAt)
        ? null
        : safeIsoString(observedAt),
    windows,
  };
}
