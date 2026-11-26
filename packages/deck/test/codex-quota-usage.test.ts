import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpQuotaHome, readAcpUsageReading } from "../app/lib/acp-usage.server";
import { buildCodexQuotaDisplay, type CodexQuotaDisplayData } from "../app/lib/codex-quota-display";
import { initialQuotaState } from "../app/lib/codex-quota";
import * as observer from "../app/lib/codex-quota-observer.server";
import { codexUsageReading } from "../app/lib/codex-quota-usage";
import { codexAcp1Manifest } from "../app/lib/runner/acp-manifest";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const readAt = new Date(now).toISOString();
const agent = "fixture-codex";
const unknown = { state: "unknown", source: "codex", readAt };
function display(over: Partial<CodexQuotaDisplayData["quota"]> = {}): CodexQuotaDisplayData {
  return {
    quota: { freshness: "fresh", status: "AVAILABLE_CONFIRMED", available: true,
      blocked: false, warning: null, observedAt: readAt,
      windows: [{ key: "primary", label: "5-hour", usedPercent: 42, resetAt: null },
        { key: "secondary", label: "7-day", usedPercent: 71, resetAt: readAt }], ...over },
    providers: { [agent]: "plus" },
  };
}
let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function configureCodexAgent() {
  root = mkdtempSync(join(tmpdir(), "deck-acp-usage-"));
  const home = join(root, agent);
  mkdirSync(home);
  writeFileSync(join(home, ".runner"), "acp\n");
  writeFileSync(join(home, ".runtime"), "codex\n");
  const env = {
    AGENTS_HOME: root, DATA_ROOT: root, CODEX_HOME: home, MC_ACP_RUNNER: "1", MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1",
  };
  return { home, env, quotaFile: join(root, "codex-quota.json") };
}

function saveAvailableQuota(quotaFile: string, env: NodeJS.ProcessEnv, usedPercent = 20) {
  writeFileSync(quotaFile, JSON.stringify({
    ...initialQuotaState(), quotaContext: observer.quotaContextForHome(observer.observerQuotaHome(env)),
    status: "AVAILABLE_CONFIRMED", observedAt: now, snapshot: { primary: { usedPercent } },
  }));
}

describe("Codex ACP usage mapping", () => {
  it.each(["missing", "malformed", "stale"] as const)("keeps %s evidence unknown, including old blocked evidence", (freshness) => {
    expect(codexUsageReading(display({ freshness, status: "BLOCKED_CONFIRMED", blocked: true }), agent, now)).toEqual(unknown);
  });

  it.each(["UNKNOWN", "RECOVERY_CANDIDATE", "PROBING"] as const)("does not infer availability or exhaustion from %s at 100 percent", (status) => {
    expect(codexUsageReading(display({ status, windows: [{ key: "primary", label: "5-hour", usedPercent: 100, resetAt: null }] }), agent, now)).toEqual(unknown);
  });

  it("preserves nullable and ISO reset times for fresh confirmed availability", () => {
    expect(codexUsageReading(display(), agent, now)).toEqual({ state: "ok", source: "codex", readAt,
      windows: [{ label: "5-hour", usedPercent: 42, resetsAt: null }, { label: "7-day", usedPercent: 71, resetsAt: readAt }] });
    const low = display();
    low.quota.windows[0]!.usedPercent = 90;
    expect(codexUsageReading(low, agent, now).state).toBe("low");
  });

  it.each(["OK", "WARN"] as const)("supports explicit %s display states", (status) => {
    const data = display();
    expect(codexUsageReading({ ...data, quota: { ...data.quota, status } }, agent, now).state).toBe(status === "OK" ? "ok" : "low");
  });

  it("maps confirmed blocking and view.blocked to exhausted", () => {
    for (const quota of [{ status: "BLOCKED_CONFIRMED" as const }, { blocked: true }]) {
      expect(codexUsageReading(display(quota), agent, now).state).toBe("exhausted");
    }
  });

  it("hides Plus windows for Azure, even with confirmed blocked evidence", () => {
    const data = display({ status: "BLOCKED_CONFIRMED", blocked: true });
    data.providers[agent] = "azure";
    expect(codexUsageReading(data, agent, now)).toEqual({ ...unknown, source: "codex-azure" });
  });

  it("reads only the selected runtime through the server seam and honours telemetry-off", () => {
    // Never launch an observer or a real runtime from this deterministic fixture.
    const ensure = vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, home, quotaFile } = configureCodexAgent();
    expect(readAcpUsageReading(env, agent, now)).toEqual(unknown);
    writeFileSync(quotaFile, "malformed");
    expect(readAcpUsageReading(env, agent, now)).toEqual(unknown);
    saveAvailableQuota(quotaFile, env);
    expect(readAcpUsageReading(env, agent, now).state).toBe("ok");
    ensure.mockClear();
    expect(readAcpUsageReading({ ...env, MC_CODEX_QUOTA_TELEMETRY_ENABLED: "0" }, agent, now)).toEqual(unknown);
    expect(ensure).not.toHaveBeenCalled();
    mkdirSync(join(env.DATA_ROOT, "provider-switch", "current"), { recursive: true });
    writeFileSync(join(env.DATA_ROOT, "provider-switch", "current", `${agent}.json`), JSON.stringify({ agent, provider: "azure" }));
    expect(readAcpUsageReading(env, agent, now)).toEqual({ ...unknown, source: "codex-azure" });
    expect(readAcpUsageReading({ ...env, MC_CODEX_QUOTA_TELEMETRY_ENABLED: "0" }, agent, now)).toEqual({ ...unknown, source: "codex-azure" });
    writeFileSync(join(home, ".runtime"), "agy\n");
    expect(readAcpUsageReading(env, agent, now)).toEqual({ ...unknown, source: "antigravity" });
  });

  it("shows same-home quota and hides quota from a different observer home", () => {
    vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, home, quotaFile } = configureCodexAgent();
    const isolated = join(env.AGENTS_HOME, "isolated-login");
    mkdirSync(isolated);
    const observerIsolated = { ...env, MC_CODEX_QUOTA_CODEX_HOME: isolated };
    saveAvailableQuota(quotaFile, observerIsolated);
    expect(readAcpUsageReading(observerIsolated, agent, now)).toEqual(unknown);
    const matching = { ...observerIsolated, CODEX_HOME: "../isolated-login" };
    expect(readAcpUsageReading(matching, agent, now).state).toBe("ok");

    const active = { manifest: codexAcp1Manifest, codexQuotaHome: acpQuotaHome(codexAcp1Manifest, env, home) };
    expect(readAcpUsageReading(matching, agent, now, active)).toEqual(unknown);

    // The observer configuration can change before the next sample arrives.
    expect(readAcpUsageReading(env, agent, now, active)).toEqual(unknown);
    saveAvailableQuota(quotaFile, env);
    expect(readAcpUsageReading(env, agent, now, active).state).toBe("ok");
  });

  it("keeps quota in a running ACP session across a routine credential refresh", () => {
    vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, home, quotaFile } = configureCodexAgent();
    const authFile = join(home, "auth.json");
    writeFileSync(authFile, "");
    const active = { manifest: codexAcp1Manifest, codexQuotaHome: acpQuotaHome(codexAcp1Manifest, env, home) };
    saveAvailableQuota(quotaFile, env);
    expect(readAcpUsageReading(env, agent, now, active).state).toBe("ok");

    const replacement = join(home, "replacement.json");
    writeFileSync(replacement, "");
    renameSync(replacement, authFile);
    expect(readAcpUsageReading(env, agent, now, active).state).toBe("ok");
    saveAvailableQuota(quotaFile, env, 30);
    expect(readAcpUsageReading(env, agent, now, active)).toMatchObject({ state: "ok", windows: [{ usedPercent: 30 }] });
  });

  it("keeps the ACP launch home match when a first-run Codex directory is created", () => {
    vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, home, quotaFile } = configureCodexAgent();
    const codexHome = join(home, "first-run");
    const firstRun = { ...env, CODEX_HOME: codexHome };
    const active = { manifest: codexAcp1Manifest, codexQuotaHome: acpQuotaHome(codexAcp1Manifest, firstRun, home) };
    expect(active.codexQuotaHome).toBe(observer.observerQuotaHome(firstRun));
    expect(readAcpUsageReading(firstRun, agent, now, active)).toEqual(unknown);

    mkdirSync(codexHome);
    saveAvailableQuota(quotaFile, firstRun);
    expect(readAcpUsageReading(firstRun, agent, now, active).state).toBe("ok");
  });

  it("shows quota for a keyring login with no credential file", () => {
    vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, home, quotaFile } = configureCodexAgent();
    const active = { manifest: codexAcp1Manifest, codexQuotaHome: acpQuotaHome(codexAcp1Manifest, env, home) };
    saveAvailableQuota(quotaFile, env);
    expect(readAcpUsageReading(env, agent, now, active).state).toBe("ok");
  });

  it("hides legacy snapshots until the observer saves quota for its home", () => {
    vi.spyOn(observer, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    const { env, quotaFile } = configureCodexAgent();
    const state = {
      ...initialQuotaState(), status: "AVAILABLE_CONFIRMED", observedAt: now,
      snapshot: { primary: { usedPercent: 20 } },
    };
    writeFileSync(quotaFile, JSON.stringify({ ...state, quotaContext: "a".repeat(64) }));
    expect(readAcpUsageReading(env, agent, now)).toEqual(unknown);
    writeFileSync(quotaFile, JSON.stringify(state));
    expect(readAcpUsageReading(env, agent, now)).toEqual(unknown);
    saveAvailableQuota(quotaFile, env);
    expect(readAcpUsageReading(env, agent, now).state).toBe("ok");
  });

  it("maps stale snapshots built by the real display model conservatively", () => {
    const quota = buildCodexQuotaDisplay({ kind: "ok", state: { ...initialQuotaState(),
      observedAt: now - 1_000_000, status: "BLOCKED_CONFIRMED" } }, now, 900_000);
    expect(codexUsageReading({ quota, providers: {} }, agent, now)).toEqual(unknown);
  });

  it("uses an injected environment for singleton observer opt-in and opt-out", async () => {
    vi.resetModules();
    const { ensureCodexQuotaObserver } = await import("../app/lib/codex-quota-observer.server");
    const connect = vi.fn(() => ({ send: vi.fn(), onLine: vi.fn(), onClose: vi.fn(), close: vi.fn() }));
    const store = { load: initialQuotaState, save: vi.fn() };
    vi.stubEnv("MC_CODEX_QUOTA_TELEMETRY_ENABLED", "1");
    expect(ensureCodexQuotaObserver({ env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "0" }, connect, store })).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    vi.stubEnv("MC_CODEX_QUOTA_TELEMETRY_ENABLED", "0");
    const active = ensureCodexQuotaObserver({ env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" }, connect, store });
    try {
      expect(active).toBeDefined();
      expect(connect).toHaveBeenCalledOnce();
    } finally { active?.stop(); }
  });
});
