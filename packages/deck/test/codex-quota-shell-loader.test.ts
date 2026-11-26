import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as observer from "~/lib/codex-quota-observer.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

vi.mock("~/lib/stores.server", () => ({
  makeStores: () => ({
    inbox: {
      listAgents: async () => ["alex", "scribe"],
      readBlocks: async () => [],
    },
    queue: {
      getHandled: async () => new Set<string>(),
      getDeadlines: async () => new Map<string, string>(),
    },
  }),
}));

vi.mock("~/lib/projects.server", () => ({ listCards: () => [] }));
vi.mock("~/lib/avatars.server", () => ({ avatarUrl: () => undefined }));

import { loader } from "~/routes/shell";

const NOW = Date.parse("2026-09-16T08:00:00Z");
let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync();
  vi.stubEnv("DATA_ROOT", dataRoot);
  vi.stubEnv("MC_NOW", "2026-09-16T08:00:00Z");
  vi.stubEnv("ACTIVITY_ROOT", undefined);
  vi.stubEnv("MC_CODEX_QUOTA_TELEMETRY_ENABLED", "1");
  vi.stubEnv("MC_CODEX_QUOTA_CODEX_HOME", path.join(dataRoot, "observer-home"));
  vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dataRoot);
});

function saveQuota() {
  fs.writeFileSync(
    path.join(dataRoot, "codex-quota.json"),
    JSON.stringify({
      version: 1,
      quotaContext: observer.quotaContextForHome(observer.observerQuotaHome(process.env)),
      status: "AVAILABLE_CONFIRMED",
      observedAt: NOW - 1_000,
      source: "full_read",
      blockedReason: null,
      resetCandidateAt: null,
      snapshot: {
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: null },
      },
    }),
    "utf8"
  );
}

function loadThread() {
  return loader({
    params: { agent: "alex" },
    request: new Request("http://deck.test/threads/alex"),
    context: {},
  } as never);
}

describe("shell loader Codex quota wiring", () => {
  it("ships one quota view and explicit per-agent provider evidence", async () => {
    saveQuota();
    fs.mkdirSync(path.join(dataRoot, "provider-switch", "current"), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "provider-switch", "current", "alex.json"),
      JSON.stringify({
        version: 1,
        agent: "alex",
        provider: "plus",
        observedAt: NOW,
        operationId: "switch-1",
      }),
      "utf8"
    );

    const result = await loadThread();

    expect(result.codexQuota.quota.windows.map((window) => window.label)).toEqual([
      "5-hour",
      "7-day",
    ]);
    expect(result.codexQuota.providers).toEqual({ alex: "plus", scribe: "unknown" });
  });

  it("hides the previous observer home's quota on the first load after switching homes", async () => {
    saveQuota();
    vi.stubEnv("MC_CODEX_QUOTA_CODEX_HOME", path.join(dataRoot, "new-observer-home"));

    const result = await loadThread();

    expect(result.codexQuota.quota).toMatchObject({ freshness: "missing", windows: [] });
  });
});
