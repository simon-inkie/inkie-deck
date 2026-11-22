import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSession, type AcpAdapter } from "../../app/lib/acp-session.server.js";
import {
  antigravity1Manifest,
  type AcpAdapterManifest,
} from "../../app/lib/runner/acp-manifest.js";
import { claimRunnerLock, hasCode } from "../../app/lib/runner/lock.server.js";
import { AcpRunnerRegistry } from "../../app/lib/runner/acp-registry.server.js";
import { StartRefusal } from "../../app/lib/runner/registry.server.js";
import { LaunchFailure } from "../../app/lib/runner/runner.js";

const agent = "fixture-acp-agent";
const otherAgent = "fixture-acp-agent-2";

describe("ACP Runner Registry, Lock, Lifecycle and Descendant-Kill", () => {
  let root: string;
  let home: string;
  let otherHome: string;
  let lockFile: string;
  let env: NodeJS.ProcessEnv;
  let fakeAgyScript: string;
  let treeSpawnerScript: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deck-acp-reg-"));
    home = join(root, agent);
    otherHome = join(root, otherAgent);
    lockFile = join(home, ".runner.lock");
    mkdirSync(home, { recursive: true });
    mkdirSync(otherHome, { recursive: true });

    // Setup agent opt-ins
    writeFileSync(join(home, ".runner"), "acp\n");
    writeFileSync(join(home, ".runtime"), "agy\n");
    writeFileSync(join(otherHome, ".runner"), "acp\n");
    writeFileSync(join(otherHome, ".runtime"), "agy\n");

    env = {
      AGENTS_HOME: root,
      MC_ACP_RUNNER: "1",
      HOME: root,
      PATH: process.env.PATH,
    };

    // Create a real fake agy script for version check and minimal ACP mock
    fakeAgyScript = join(root, "agy");
    writeFileSync(
      fakeAgyScript,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
# Minimal ACP loop
while read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}\\n'
      ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session-1234"}}\\n'
      ;;
    *)
      ;;
  esac
done
`,
      { mode: 0o755 },
    );

    // Create a real process-tree spawner script that forks descendants into the same process group
    treeSpawnerScript = join(root, "tree-spawner");
    writeFileSync(
      treeSpawnerScript,
      `#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
# Spawn descendant grandchild in background in the same process group
sleep 100 &
PID1=$!
sleep 100 &
PID2=$!
echo "PIDS:$PID1,$PID2"
# Keep parent running until signaled
while true; do
  sleep 1
done
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    try {
      const reg = new AcpRunnerRegistry(env);
      await reg.stop(agent);
      await reg.stop(otherAgent);
    } catch {}
    const globals = globalThis as any;
    const registryKey = Symbol.for("inkie-deck.acp.registry");
    if (globals[registryKey]) {
      globals[registryKey].sessions.clear();
      globals[registryKey].closing = false;
      globals[registryKey].recoveryFailed = false;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses to start when agent is not opted in", async () => {
    // Unset MC_ACP_RUNNER
    const regWithoutFlag = new AcpRunnerRegistry({ ...env, MC_ACP_RUNNER: "0" });
    await expect(regWithoutFlag.start(agent)).rejects.toMatchObject({
      name: "StartRefusal",
      reason: "not-opted-in",
    });

    // Unset .runner
    rmSync(join(home, ".runner"));
    const reg = new AcpRunnerRegistry(env);
    await expect(reg.start(agent)).rejects.toMatchObject({
      name: "StartRefusal",
      reason: "not-opted-in",
    });
  });

  it("refuses to start when agent has an active tmux window", async () => {
    const reg = new AcpRunnerRegistry(env, {
      listWindows: () => [agent, "other"],
    });
    await expect(reg.start(agent)).rejects.toMatchObject({
      name: "StartRefusal",
      reason: "tmux-active",
    });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("refuses to start when agy version is below semver floor", async () => {
    const reg = new AcpRunnerRegistry(env, {
      manifest: {
        ...antigravity1Manifest,
        executableName: fakeAgyScript,
        semverFloor: "1.5.0",
      },
      execVersion: () => ({ status: 0, stdout: "1.4.2\n", stderr: "" }),
    });

    await expect(reg.start(agent)).rejects.toThrowError(LaunchFailure);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("claims .runner.lock and releases it when session stops", async () => {
    let spawnedPid = 0;
    const reg = new AcpRunnerRegistry(env, {
      manifest: {
        ...antigravity1Manifest,
        executableName: fakeAgyScript,
      },
      startSession: async (_adapter, options) => {
        // Spawn a real POSIX process group with detached: true
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          cwd: options.cwd,
          detached: true,
          stdio: "ignore",
        });
        spawnedPid = child.pid!;
        options.onSpawn?.(child.pid!);
        return {
          state: { kind: "idle" },
          capabilities: {},
          pid: child.pid,
          exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
          cancel: async () => {},
        } as unknown as AcpSession;
      },
    });

    await reg.start(agent);
    expect(reg.status(agent)).toEqual({ state: "running" });

    // Verify .runner.lock exists on disk and contains childPid
    expect(existsSync(lockFile)).toBe(true);
    const lockContent = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(lockContent.childPid).toBe(spawnedPid);
    expect(lockContent.deckPid).toBe(process.pid);

    // Contention check: second start for same agent is refused
    await expect(reg.start(agent)).rejects.toMatchObject({
      name: "StartRefusal",
      reason: "busy",
    });

    // Stop session and verify clean lock release
    await reg.stop(agent);
    expect(existsSync(lockFile)).toBe(false);
    expect(reg.status(agent)).toMatchObject({ state: "stopped" });
  });

  it("kills all descendant processes in the process group on stop (real child and grandchild)", async () => {
    let descendantPids: number[] = [];
    let parentPid = 0;

    const reg = new AcpRunnerRegistry(env, {
      manifest: {
        ...antigravity1Manifest,
        executableName: treeSpawnerScript,
      },
      startSession: async (_adapter, options) => {
        // Spawn real bash tree spawner in detached process group
        const child = spawn("bash", [treeSpawnerScript], {
          cwd: options.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        parentPid = child.pid!;
        options.onSpawn?.(child.pid!);

        // Read output line containing grandchild PIDs
        await new Promise<void>((resolve) => {
          child.stdout?.once("data", (data) => {
            const line = Buffer.from(data).toString("utf8");
            const match = line.match(/PIDS:(\d+),(\d+)/);
            if (match) {
              descendantPids = [Number(match[1]), Number(match[2])];
            }
            resolve();
          });
        });

        return {
          state: { kind: "idle" },
          capabilities: {},
          pid: child.pid,
          exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
          cancel: async () => {},
        } as unknown as AcpSession;
      },
    });

    await reg.start(agent);
    expect(parentPid).toBeGreaterThan(0);
    expect(descendantPids.length).toBe(2);

    // Verify parent and both descendants are alive before stop
    expect(() => process.kill(parentPid, 0)).not.toThrow();
    for (const pid of descendantPids) {
      expect(() => process.kill(pid, 0)).not.toThrow();
    }

    // Stop session via registry (triggers group kill)
    await reg.stop(agent);

    // Allow brief grace period for process reaper
    await delay(100);

    // Verify parent is dead
    expect(() => process.kill(parentPid, 0)).toThrow();

    // CRITICAL: verify all descendant grandchild processes are dead (no orphans!)
    for (const pid of descendantPids) {
      let isDead = false;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (hasCode(err, "ESRCH")) isDead = true;
      }
      expect(isDead).toBe(true);
    }
  });

  it("logs unknown extension notifications as structured events in run record without display (Decision 3)", async () => {
    // Test the unknown extension notification path in AcpSession directly with real records
    const sessionDir = join(root, "session-records");
    mkdirSync(sessionDir, { recursive: true });

    // Create an agent script that sends an unknown extension notification
    const scriptPath = join(root, "ext-agent.mjs");
    writeFileSync(
      scriptPath,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-ext-1" } }) + "\\n");
    // Send known allowlisted extension notification (should be dropped silently)
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "antigravity/heartbeat", params: { beat: 1 } }) + "\\n");
    // Send unknown extension notification (should be logged to extensions.ndjson, NOT displayed)
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_custom_extension/event", params: { payload: "foo" } }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );

    const eventsEmitted: any[] = [];
    const session = await AcpSession.start(
      {
        executable: process.execPath,
        args: [scriptPath],
        version: "1.5.0",
        knownExtensions: ["antigravity/heartbeat"],
      },
      {
        cwd: root,
        dataRoot: sessionDir,
        onEvent: (event) => eventsEmitted.push(event),
      },
    );

    // Wait briefly for notifications to be processed
    await delay(150);

    // Verify session remained healthy and did NOT fail/violate from the unknown extension
    expect(session.state.kind).toBe("idle");

    // Verify no display event was generated for the unknown extension
    const extEvents = eventsEmitted.filter((e) => e.type === "unknown_extension_notification");
    expect(extEvents).toHaveLength(0);

    // Verify structured event was logged to extensions.ndjson in run records
    const extLogPath = join(session.records.directory, "extensions.ndjson");
    expect(existsSync(extLogPath)).toBe(true);
    const content = readFileSync(extLogPath, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content);
    expect(parsed).toMatchObject({
      v: 1,
      extensionName: "_custom_extension/event",
      method: "_custom_extension/event",
      params: { payload: "foo" },
    });

    await session.cancel();
  });
});
