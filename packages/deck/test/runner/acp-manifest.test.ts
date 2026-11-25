import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravity1Manifest,
  codexAcp1Manifest,
  resolveAcpManifest,
  resolveAcpManifestForAgent,
  probeAgyVersion,
  antigravityUsageReading,
  checkAgyVersion,
  compareSemver,
  isAcpOptedIn,
  parseSemver,
  resolveAcpExecutable,
  type UsageReading,
} from "../../app/lib/runner/acp-manifest.js";
import { LaunchFailure } from "../../app/lib/runner/runner.js";

describe("ACP Manifest, Version and Opt-In Guards", () => {
  let tempDir: string;
  let agentsHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deck-acp-manifest-"));
    agentsHome = join(tempDir, "agents");
    mkdirSync(agentsHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("UsageReading (Decision 4)", () => {
    it("defines UsageReading and returns unknown for Antigravity", () => {
      const fixedTime = "2026-11-22T19:30:00.000Z";
      const reading: UsageReading = antigravityUsageReading(() => fixedTime);
      expect(reading).toEqual({
        state: "unknown",
        source: "antigravity",
        readAt: fixedTime,
      });
      expect(reading.state).toBe("unknown");
    });
  });

  describe("Semver parsing and floor comparison", () => {
    it("parses valid semver versions and rejects leading zeros", () => {
      expect(parseSemver("1.5.0")).toEqual({ major: 1, minor: 5, patch: 0, prerelease: [] });
      expect(parseSemver("v1.5.14")).toEqual({ major: 1, minor: 5, patch: 14, prerelease: [] });
      expect(parseSemver("  2.0.1-beta.1  ")).toEqual({ major: 2, minor: 0, patch: 1, prerelease: ["beta", "1"] });
      expect(parseSemver("invalid")).toBeNull();
      expect(parseSemver("1.5")).toBeNull();
      expect(parseSemver("01.5.0")).toBeNull();
      expect(parseSemver("1.5.0-01")).toBeNull();
    });

    it("compares semver versions against floor including prerelease precedence", () => {
      expect(compareSemver("1.5.0", "1.5.0")).toBe(0);
      expect(compareSemver("1.5.14", "1.5.0")).toBe(1);
      expect(compareSemver("1.6.0", "1.5.0")).toBe(1);
      expect(compareSemver("2.0.0", "1.5.0")).toBe(1);
      expect(compareSemver("1.4.9", "1.5.0")).toBe(-1);
      expect(compareSemver("0.9.0", "1.5.0")).toBe(-1);
      expect(compareSemver("1.5.0-rc.1", "1.5.0")).toBe(-1);
      expect(compareSemver("1.5.1-rc.1", "1.5.0")).toBe(1);
    });
  });

  it("registers the documented Codex defaults without API keys", () => {
    expect(resolveAcpManifest("agy")).toBe(antigravity1Manifest);
    expect(resolveAcpManifest("codex")).toEqual({
      name: "codex-acp-1", runtime: "codex", runner: "acp",
      executableName: "codex-acp", args: [], semverFloor: "2.6.0",
      envAllowlist: ["CODEX_HOME", "CODEX_PATH", "NO_BROWSER"],
      envDefaults: { NO_BROWSER: "1" }, knownExtensions: [],
      displayName: "Codex ACP", authHint: "Sign in with `codex login` in a terminal.",
      usageKind: "codex",
    });
    for (const runtime of [undefined, "", "unknown", "constructor"]) {
      expect(resolveAcpManifest(runtime)).toBeUndefined();
    }
  });

  it.each(["2.6.0", "codex-acp 2.6.0", "\n  \ncodex-cli 2.6.0\nignored"])("parses first non-empty version line: %s", async (stdout) => {
    const options = { displayName: "Codex ACP", exec: () => ({ status: 0, stdout, stderr: "" }) };
    expect(checkAgyVersion("fixture", "2.6.0", options)).toEqual({ version: "2.6.0", ok: true });
    expect(await probeAgyVersion("fixture", "2.6.0", options)).toEqual({ version: "2.6.0", ok: true });
  });

  it.each(["codex-acp 2.5.9", "codex-acp 2.6.0-rc.1", "garbage\n2.6.0", "too many 2.6.0", ""])("rejects invalid or below-floor Codex output: %s", (stdout) => {
    expect(() => checkAgyVersion("fixture", "2.6.0", {
      displayName: codexAcp1Manifest.displayName,
      exec: () => ({ status: 0, stdout, stderr: "" }),
    })).toThrow(/Codex ACP/);
  });

  describe("Version check (semver floor)", () => {
    it("accepts versions at or above floor", () => {
      const res1 = checkAgyVersion("dummy", "1.5.0", {
        exec: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
      });
      expect(res1.ok).toBe(true);
      expect(res1.version).toBe("1.5.0");

      const res2 = checkAgyVersion("dummy", "1.5.0", {
        exec: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      });
      expect(res2.ok).toBe(true);
      expect(res2.version).toBe("1.5.14");
    });

    it("rejects versions strictly below semver floor", () => {
      expect(() => {
        checkAgyVersion("dummy", "1.5.0", {
          exec: () => ({ status: 0, stdout: "1.4.9\n", stderr: "" }),
        });
      }).toThrowError(LaunchFailure);

      try {
        checkAgyVersion("dummy", "1.5.0", {
          exec: () => ({ status: 0, stdout: "1.4.9\n", stderr: "" }),
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LaunchFailure);
        expect((err as LaunchFailure).reason).toBe("unavailable");
        expect((err as LaunchFailure).message).toContain("does not meet required semver floor");
      }
    });

    it("allows mismatch when explicitly permitted", () => {
      const res = checkAgyVersion("dummy", "1.5.0", {
        allowMismatch: true,
        exec: () => ({ status: 0, stdout: "1.4.9\n", stderr: "" }),
      });
      expect(res.ok).toBe(false);
      expect(res.version).toBe("1.4.9");
    });

    it("handles command failure", () => {
      expect(() => {
        checkAgyVersion("dummy", "1.5.0", {
          exec: () => ({ status: 1, stdout: "", stderr: "command not found" }),
        });
      }).toThrowError(LaunchFailure);
    });
  });

  describe("resolveAcpExecutable", () => {
    it("resolves an absolute path to an executable file", () => {
      const binPath = join(tempDir, "fake-agy");
      writeFileSync(binPath, "#!/bin/sh\necho 1.5.14\n", { mode: 0o755 });
      const resolved = resolveAcpExecutable(binPath, { PATH: "" });
      expect(resolved).toBe(binPath);
    });

    it("resolves executable from trusted absolute PATH and rejects relative PATH or agent-home binaries", () => {
      const binDir = join(tempDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, "agy");
      writeFileSync(binPath, "#!/bin/sh\necho 1.5.14\n", { mode: 0o755 });

      const resolved = resolveAcpExecutable("agy", { PATH: binDir }, agentsHome);
      expect(resolved).toBe(binPath);

      // Major 5 guard: reject relative PATH entries like '.'
      expect(() => resolveAcpExecutable("agy", { PATH: "." }, agentsHome)).toThrowError(LaunchFailure);

      // Major 5 guard: reject executable inside agent home
      const homeBin = join(agentsHome, "agy");
      writeFileSync(homeBin, "#!/bin/sh\necho 1.5.14\n", { mode: 0o755 });
      expect(() => resolveAcpExecutable("agy", { PATH: agentsHome }, agentsHome)).toThrowError(LaunchFailure);
    });

    it("runs version probe with constrained environment excluding Deck secrets", () => {
      let seenEnv: NodeJS.ProcessEnv | undefined;
      checkAgyVersion("dummy", "1.5.0", {
        env: {
          PATH: "/usr/bin",
          HOME: tempDir,
          DEEPGRAM_API_KEY: "secret-key",
          DECK_TOKEN: "secret-token",
          MC_ACP_RUNNER: "1",
        },
        exec: (_cmd, _args, opts) => {
          seenEnv = opts?.env;
          return { status: 0, stdout: "1.5.14\n", stderr: "" };
        },
      });
      expect(seenEnv?.PATH).toBe("/usr/bin");
      expect(seenEnv?.DEEPGRAM_API_KEY).toBeUndefined();
      expect(seenEnv?.DECK_TOKEN).toBeUndefined();
      expect(seenEnv?.MC_ACP_RUNNER).toBeUndefined();
    });

    it("throws LaunchFailure if not executable or not in PATH", () => {
      const nonExec = join(tempDir, "non-exec");
      writeFileSync(nonExec, "text", { mode: 0o644 });
      expect(() => resolveAcpExecutable(nonExec, { PATH: "" })).toThrowError(LaunchFailure);
      expect(() => resolveAcpExecutable("missing-binary-xyz", { PATH: tempDir })).toThrowError(LaunchFailure);
    });
  });

  describe("isAcpOptedIn matrix", () => {
    function setupAgent(agentName: string, runnerContent?: string, runtimeContent?: string) {
      const agentDir = join(agentsHome, agentName);
      mkdirSync(agentDir, { recursive: true });
      if (runnerContent !== undefined) {
        writeFileSync(join(agentDir, ".runner"), runnerContent);
      }
      if (runtimeContent !== undefined) {
        writeFileSync(join(agentDir, ".runtime"), runtimeContent);
      }
      return agentDir;
    }

    it("requires MC_ACP_RUNNER=1, .runner=acp and a registered runtime", () => {
      const agent = "agent-alpha";
      setupAgent(agent, "acp\n", "agy\n");

      // Opted in when MC_ACP_RUNNER is 1
      expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, agent)).toBe(true);

      const agentMissingRuntime = "agent-missing-runtime";
      setupAgent(agentMissingRuntime, "acp\n");
      expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, agentMissingRuntime)).toBe(false);

      // Rejects if MC_ACP_RUNNER is not "1"
      for (const flag of [undefined, "0", "false", "true", "2", " 1 "]) {
        expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: flag }, agent)).toBe(false);
      }

      // Rejects if .runner is not "acp"
      for (const runner of ["pty", "tmux", "acp-other", "ACP", ""]) {
        setupAgent(agent, runner + "\n", "agy\n");
        expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, agent)).toBe(false);
      }

      // Rejects if .runner file is missing
      const agentMissing = "agent-missing-runner";
      setupAgent(agentMissing, undefined, "agy\n");
      expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, agentMissing)).toBe(false);

      setupAgent(agent, "acp\n", "codex\n");
      const env = { AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" };
      expect(isAcpOptedIn(env, agent)).toBe(true);
      expect(resolveAcpManifestForAgent(env, agent)).toBe(codexAcp1Manifest);

      // Rejects unknown runtimes
      for (const runtime of ["claude", "other", ""]) {
        setupAgent(agent, "acp\n", runtime + "\n");
        expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, agent)).toBe(false);
      }

      // Rejects non-existent agent or invalid agent name
      expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, "non-existent")).toBe(false);
      expect(isAcpOptedIn({ AGENTS_HOME: agentsHome, MC_ACP_RUNNER: "1" }, "../escape")).toBe(false);
    });
  });
});
