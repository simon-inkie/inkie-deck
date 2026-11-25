import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCodexQuotaDisplay } from "~/lib/codex-quota-display.server";
import { ensureCodexQuotaObserver } from "~/lib/codex-quota-observer.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

const roots: string[] = [];
const NOW = Date.parse("2026-09-16T08:00:00Z");

function root(): string {
  const value = mkdtempSync();
  roots.push(value);
  return value;
}

function goodState() {
  return {
    version: 1,
    status: "AVAILABLE_CONFIRMED",
    observedAt: NOW - 1_000,
    source: "full_read",
    blockedReason: null,
    resetCandidateAt: null,
    snapshot: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!);
});

describe("Codex quota display server loader", () => {
  it("logs only sanitized observer startup and exit diagnostics", () => {
    const env = { DATA_ROOT: root(), MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" };
    const child = () => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const failed = child();
    const exited = child();
    vi.mocked(spawn)
      .mockReturnValueOnce(failed as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(exited as unknown as ReturnType<typeof spawn>);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      expect(loadCodexQuotaDisplay(env, NOW, []).quota.status).toBe("UNKNOWN");
      failed.emit("error", Object.assign(new Error("startup-secret"), { code: "ENOENT" }));
      vi.advanceTimersByTime(5_000);
      exited.stdout.write("invalid frame protocol-secret\n");
      exited.stderr.write("error: permission denied for stderr-secret\n");
      exited.emit("exit", 2, null);
      vi.advanceTimersByTime(100);

      expect(warn.mock.calls).toEqual([
        ["[codex-quota] Could not start Codex quota app-server (ENOENT)."],
        ["[codex-quota] Codex quota app-server closed with exit code 2. Permission denied."],
      ]);
    } finally {
      ensureCodexQuotaObserver({ env })?.stop();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("distinguishes missing and malformed quota snapshots", () => {
    const dataRoot = root();
    const missing = loadCodexQuotaDisplay({ DATA_ROOT: dataRoot }, NOW, ["alex"]);
    expect(missing.quota.freshness).toBe("missing");

    fs.writeFileSync(path.join(dataRoot, "codex-quota.json"), "{ nope", "utf8");
    const malformed = loadCodexQuotaDisplay({ DATA_ROOT: dataRoot }, NOW, ["alex"]);
    expect(malformed.quota.freshness).toBe("malformed");
  });

  it("reads only explicit per-agent provider state and otherwise says unknown", () => {
    const dataRoot = root();
    fs.writeFileSync(path.join(dataRoot, "codex-quota.json"), JSON.stringify(goodState()), "utf8");
    fs.mkdirSync(path.join(dataRoot, "provider-switch", "current"), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "provider-switch", "current", "alex.json"),
      JSON.stringify({
        version: 1,
        agent: "alex",
        provider: "azure",
        observedAt: NOW,
        operationId: "switch-1",
      }),
      "utf8"
    );

    const loaded = loadCodexQuotaDisplay(
      { DATA_ROOT: dataRoot },
      NOW,
      ["alex", "scribe"]
    );
    expect(loaded.providers).toEqual({ alex: "azure", scribe: "unknown" });
  });

  it("never infers Azure from an available Codex quota snapshot", () => {
    const dataRoot = root();
    fs.writeFileSync(path.join(dataRoot, "codex-quota.json"), JSON.stringify(goodState()), "utf8");
    const loaded = loadCodexQuotaDisplay({ DATA_ROOT: dataRoot }, NOW, ["alex", "scribe"]);
    expect(loaded.quota.status).toBe("AVAILABLE_CONFIRMED");
    expect(loaded.providers.alex).toBe("unknown");
    expect(loaded.providers.scribe).toBe("unknown");
  });

  it("honours the configured staleness threshold with a conservative default on junk", () => {
    const dataRoot = root();
    fs.writeFileSync(path.join(dataRoot, "codex-quota.json"), JSON.stringify(goodState()), "utf8");
    expect(
      loadCodexQuotaDisplay(
        { DATA_ROOT: dataRoot, MC_CODEX_QUOTA_STALE_MS: "500" },
        NOW,
        []
      ).quota.freshness
    ).toBe("stale");
    expect(
      loadCodexQuotaDisplay(
        { DATA_ROOT: dataRoot, MC_CODEX_QUOTA_STALE_MS: "junk" },
        NOW,
        []
      ).quota.freshness
    ).toBe("fresh");
  });
});
