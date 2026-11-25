import type { CodexQuotaDisplayData } from "./codex-quota-display";
import type { UsageReading } from "./runner/acp-manifest";

type UsageDisplay = Omit<CodexQuotaDisplayData, "quota"> & {
  quota: Omit<CodexQuotaDisplayData["quota"], "status"> & {
    status: CodexQuotaDisplayData["quota"]["status"] | "OK" | "WARN";
  };
};

/** Project only fresh, confirmed quota evidence into runner usage. */
export function codexUsageReading(
  display: UsageDisplay,
  agent: string,
  now: number = Date.now(),
): UsageReading {
  const readAt = new Date(now).toISOString();
  if (display.providers[agent] === "azure") {
    return { state: "unknown", source: "codex-azure", readAt };
  }
  const view = display.quota;
  const unknown: UsageReading = { state: "unknown", source: "codex", readAt };
  if (view.freshness !== "fresh") return unknown;
  // Keep compatibility with explicit OK/WARN display producers. The current
  // observer confirms availability separately from the percentage threshold.
  const status: string = view.status;
  const state = view.blocked || status === "BLOCKED_CONFIRMED" ? "exhausted"
    : status === "WARN" ? "low"
    : status === "OK" ? "ok"
    : status === "AVAILABLE_CONFIRMED"
      ? view.windows.some((window) => window.usedPercent >= 90) ? "low" : "ok"
      : "unknown";
  if (state === "unknown") return unknown;
  return {
    state,
    source: "codex",
    readAt,
    windows: view.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetAt,
    })),
  };
}
