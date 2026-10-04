import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  process.env["DATA_ROOT"] = dataRoot;
  process.env["MC_NOW"] = "2026-09-16T08:00:00Z";
  delete process.env["ACTIVITY_ROOT"];
});

afterEach(() => {
  delete process.env["DATA_ROOT"];
  delete process.env["MC_NOW"];
  rmSync(dataRoot);
});

describe("shell loader Codex quota wiring", () => {
  it("ships one quota view and explicit per-agent provider evidence", async () => {
    fs.writeFileSync(
      path.join(dataRoot, "codex-quota.json"),
      JSON.stringify({
        version: 1,
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

    const result = await loader({
      params: { agent: "alex" },
      request: new Request("http://deck.test/threads/alex"),
      context: {},
    } as never);

    expect(result.codexQuota.quota.windows.map((window) => window.label)).toEqual([
      "5-hour",
      "7-day",
    ]);
    expect(result.codexQuota.providers).toEqual({ alex: "plus", scribe: "unknown" });
  });
});
