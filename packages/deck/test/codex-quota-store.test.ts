import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCodexQuotaStore } from "../app/lib/codex-quota-store.server";
import type { QuotaState } from "../app/lib/codex-quota";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("FileCodexQuotaStore", () => {
  it("atomically persists only the redacted quota snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-quota-"));
    sandboxes.push(root);
    const statePath = path.join(root, "codex-quota.json");
    const store = new FileCodexQuotaStore(statePath, root);
    const state: QuotaState = {
      version: 1,
      status: "BLOCKED_CONFIRMED",
      observedAt: 1_000_000,
      source: "full_read",
      blockedReason: "workspace_member_usage_limit_reached",
      resetCandidateAt: 2_000_000,
      snapshot: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: null },
        individualLimit: null,
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      },
    };

    store.save({
      ...state,
      accountId: "account-secret",
      rateLimitUpsell: { campaign: "hostile" },
      rateLimitResetCredits: [{ id: "reset-credit-secret" }],
      snapshot: {
        ...state.snapshot,
        accessToken: "token-secret",
        nestedSecret: { credential: "password-secret" },
      },
    } as QuotaState);

    const raw = fs.readFileSync(statePath, "utf8");
    expect(JSON.parse(raw)).toEqual(state);
    expect(raw).not.toContain("accountId");
    expect(raw).not.toContain("rateLimitUpsell");
    expect(raw).not.toContain("rateLimitResetCredits");
    expect(raw).not.toContain("account-secret");
    expect(raw).not.toContain("hostile");
    expect(raw).not.toContain("reset-credit-secret");
    expect(raw).not.toContain("token-secret");
    expect(raw).not.toContain("password-secret");
    expect(fs.readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("refuses traversal outside DATA_ROOT", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-quota-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-outside-"));
    sandboxes.push(root, outside);
    const store = new FileCodexQuotaStore(
      path.join(root, "..", path.basename(outside), "quota.json"),
      root
    );

    expect(() => store.save({ ...initialState() })).toThrow(/outside|escapes|root/i);
    expect(fs.existsSync(path.join(outside, "quota.json"))).toBe(false);
  });

  it("refuses a symlink escape from DATA_ROOT", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-quota-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-outside-"));
    sandboxes.push(root, outside);
    fs.symlinkSync(outside, path.join(root, "escape"));
    const store = new FileCodexQuotaStore(
      path.join(root, "escape", "quota.json"),
      root
    );

    expect(() => store.save(initialState())).toThrow(/outside|escapes|root/i);
    expect(fs.existsSync(path.join(outside, "quota.json"))).toBe(false);
  });

  it("refuses the live agent silo when sandbox-only mode is set", () => {
    const liveRoot = path.join(os.homedir(), ".the-vault");
    if (!fs.existsSync(liveRoot)) return;
    const previous = process.env["MC_SANDBOX_ONLY"];
    const previousSilo = process.env["MC_LIVE_SILO_ROOT"];
    process.env["MC_SANDBOX_ONLY"] = "1";
    process.env["MC_LIVE_SILO_ROOT"] = liveRoot;
    try {
      const store = new FileCodexQuotaStore(
        path.join(liveRoot, "codex-quota-test.json"),
        liveRoot
      );
      expect(() => store.save(initialState())).toThrow(
        /live agent silo|MC_SANDBOX_ONLY/
      );
    } finally {
      if (previous === undefined) delete process.env["MC_SANDBOX_ONLY"];
      else process.env["MC_SANDBOX_ONLY"] = previous;
      if (previousSilo === undefined) delete process.env["MC_LIVE_SILO_ROOT"];
      else process.env["MC_LIVE_SILO_ROOT"] = previousSilo;
    }
  });

  it("degrades to UNKNOWN when persisted data is invalid", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-quota-"));
    sandboxes.push(root);
    const statePath = path.join(root, "codex-quota.json");
    fs.writeFileSync(statePath, '{"accountId":"secret"}');

    const state = new FileCodexQuotaStore(statePath, root).load();

    expect(state.status).toBe("UNKNOWN");
    expect(state.snapshot).toBeNull();
  });
});

function initialState(): QuotaState {
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
