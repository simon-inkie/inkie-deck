import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSession, type AcpAdapter } from "../../app/lib/acp-session.server.js";
import {
  antigravity1Manifest,
  statExecutableIdentity,
  type AcpAdapterManifest,
} from "../../app/lib/runner/acp-manifest.js";
import { claimRunnerLock, hasCode } from "../../app/lib/runner/lock.server.js";
import { AcpRunnerRegistry } from "../../app/lib/runner/acp-registry.server.js";
import { StartRefusal } from "../../app/lib/runner/registry.server.js";
import { LaunchFailure } from "../../app/lib/runner/runner.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeSync: vi.fn(fs.writeSync) };
});

const agent = "fixture-acp-agent";
const otherAgent = "fixture-acp-agent-2";

function resumableSession(activeSessionId: string): AcpSession {
  let resolveExit!: () => void;
  return {
    state: { kind: "idle" },
    negotiated: true,
    supportsResume: () => true,
    activeSessionId,
    exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
    exitInfo: { code: 0, signal: null },
    close: async () => resolveExit(),
  } as unknown as AcpSession;
}

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

  it("runs agy and Codex concurrently with isolated control, resume identity and shutdown", async () => {
    writeFileSync(join(otherHome, ".runtime"), "codex\n");
    const fixture = new URL("../fixtures/acp-agent.mjs", import.meta.url);
    const sharedScript = { sessionId: "fixture-session", capabilities: { loadSession: true } };
    const codexScript = {
      ...sharedScript,
      prompts: [null, []],
      onCancel: [{ kind: "result", result: { stopReason: "cancelled" } }],
    };
    const script = `#!${process.execPath}
import { writeSync } from "node:fs";
if (process.argv.includes("--version")) {
  writeSync(1, "fixture 2.6.0\\n");
} else {
  process.argv[2] = process.argv[2] === "acp"
    ? ${JSON.stringify(JSON.stringify(sharedScript))}
    : ${JSON.stringify(JSON.stringify(codexScript))};
  await import(${JSON.stringify(fixture.href)});
}
`;
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Both adapter names resolve to the same executable identity.
    writeFileSync(join(bin, "agy"), script, { mode: 0o755 });
    symlinkSync(join(bin, "agy"), join(bin, "codex-acp"));
    const reg = new AcpRunnerRegistry({ ...env, PATH: bin, CODEX_PATH: join(bin, "agy") }, { listWindows: () => [] });
    const [agy, codex] = await Promise.all([reg.start(agent), reg.start(otherAgent)]);
    expect(agy.adapter.displayName).toBe("Antigravity");
    expect(codex.adapter.displayName).toBe("Codex ACP");
    expect(codex.usageReading()).toMatchObject({ source: "codex", state: "unknown" });
    expect(await agy.prompt("first")).toBe("completed");
    expect(await codex.prompt("second")).toBe("completed");
    await expect(reg.start(agent)).rejects.toMatchObject({ reason: "busy" });
    const pending = codex.prompt("hold");
    await delay(50);
    expect(await reg.cancel(otherAgent)).toBe(true);
    expect(await pending).toBe("cancelled");
    expect(await agy.prompt("still independent")).toBe("completed");
    await reg.stop(otherAgent);
    expect(reg.status(agent)?.state).toBe("running");
    expect(reg.canResume(otherAgent)).toBe(true);
    writeFileSync(join(otherHome, ".runtime"), "agy\n");
    expect(reg.canResume(otherAgent)).toBe(false);
    writeFileSync(join(otherHome, ".runtime"), "codex\n");
    expect((await reg.start(otherAgent, { resume: true })).activeSessionId).toBe("fixture-session");
    await reg.shutdown({ permanent: false });
    expect(reg.status(agent)?.state).toBe("stopped");
    expect(reg.status(otherAgent)?.state).toBe("stopped");
    expect(existsSync(join(home, ".runner.lock"))).toBe(false);
    expect(existsSync(join(otherHome, ".runner.lock"))).toBe(false);
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
    expect(reg.status(agent)).toMatchObject({ state: "running" });

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

    // Verify structured event was logged to extensions.ndjson in run records (sanitised, no raw params)
    const extLogPath = join(session.records.directory, "extensions.ndjson");
    expect(existsSync(extLogPath)).toBe(true);
    const content = readFileSync(extLogPath, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content);
    expect(parsed).toMatchObject({
      v: 1,
      session: "s-ext-1",
      extensionName: "_custom_extension/event",
      method: "_custom_extension/event",
      classification: "non-blocking",
      paramsSummary: "object(keys:1)",
    });
    expect(content).not.toContain('"foo"');
    expect(content).not.toContain('"payload"');

    await session.close();
  });

  it("Major 2: reserves starting state during negotiation, blocks the same home, and aborts on stop()", async () => {
    let releaseNegotiation!: () => void;
    let abortedObserved = false;
    const reg = new AcpRunnerRegistry(env, {
      manifest: { ...antigravity1Manifest, executableName: fakeAgyScript },
      startSession: async (_adapter, options) => {
        options.signal?.addEventListener("abort", () => {
          abortedObserved = true;
          releaseNegotiation();
        });
        await new Promise<void>((resolve) => { releaseNegotiation = resolve; });
        throw new Error("aborted during negotiation");
      },
    });

    const startPromise = reg.start(agent);
    await delay(50);

    // Status is visibly 'starting' during negotiation
    expect(reg.status(agent)).toMatchObject({ state: "starting" });

    // The same home remains busy while negotiation is in flight.
    await expect(reg.start(agent)).rejects.toMatchObject({
      name: "StartRefusal",
      reason: "busy",
    });

    // stop() aborts the in-flight start cleanly
    await reg.stop(agent);
    await expect(startPromise).rejects.toThrow();
    expect(abortedObserved).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("Major 3: pre-spawn failure releases .runner.lock cleanly and terminal negotiation does not publish running", async () => {
    const missingDataRoot = join(root, "does-not-exist-root");
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: missingDataRoot,
      manifest: { ...antigravity1Manifest, executableName: fakeAgyScript },
    });

    // Pre-spawn AcpRecords construction fails because dataRoot does not exist
    await expect(reg.start(agent)).rejects.toThrow();
    // Lock must NOT be stranded on disk
    expect(existsSync(lockFile)).toBe(false);

    // Terminal negotiation ('unsupported') must reject start() and not leave status running
    const reg2 = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: fakeAgyScript },
      startSession: async () => ({
        state: { kind: "unsupported" },
        capabilities: {},
        pid: undefined,
        exited: Promise.resolve(),
        exitInfo: { code: 0, signal: null },
        close: async () => {},
        cancel: async () => {},
      } as unknown as AcpSession),
    });

    await expect(reg2.start(agent)).rejects.toThrowError(LaunchFailure);
    expect(existsSync(lockFile)).toBe(false);
    expect(reg2.status(agent)?.state).not.toBe("running");
  });

  it("Major 4: injects DECK_PTY_SESSION_ID ownership marker into ACP child environment", async () => {
    const markerScript = join(root, "marker-agent.mjs");
    writeFileSync(
      markerScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-marker" } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-marker", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.DECK_PTY_SESSION_ID || "MISSING" } } }
    }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );

    const events: any[] = [];
    const session = await AcpSession.start(
      { executable: process.execPath, args: [markerScript], version: "1.5.0" },
      { cwd: root, dataRoot: root, sessionMarker: "11111111-2222-4333-8444-555555555555", onEvent: (e) => events.push(e) },
    );
    expect(await session.prompt("check marker")).toBe("completed");
    expect(events.some((e) => e.view?.kind === "text" && e.view.excerpt === "11111111-2222-4333-8444-555555555555")).toBe(true);
    await session.close();
  });

  it("Major 6 & 7: classifies blocking unknown request (-32601 + error card) and bounds extensions.ndjson", async () => {
    const blockingScript = join(root, "blocking-ext-agent.mjs");
    writeFileSync(
      blockingScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let gotMethodNotFound = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-block" } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    // Send a blocking unknown request with an id
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ext/unknown_prompt", params: { secret: "top-secret-token" } }) + "\\n");
    // Wait briefly for -32601 reply before completing turn
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: gotMethodNotFound ? "end_turn" : "refusal" } }) + "\\n");
    }, 80);
  } else if (msg.id === 99 && msg.error && msg.error.code === -32601) {
    gotMethodNotFound = true;
  }
});
`,
      { mode: 0o755 },
    );

    const events: any[] = [];
    const session = await AcpSession.start(
      { executable: process.execPath, args: [blockingScript], version: "1.5.0" },
      { cwd: root, dataRoot: root, extensionsBytes: 512, onEvent: (e) => events.push(e) },
    );
    const outcome = await session.prompt("trigger blocking ext");
    expect(outcome).toBe("completed");

    // Blocking request must emit plain fixed-text action card
    expect(events.some((e) => e.class === "action" && e.type === "extension.blocking" && e.title === "Something went wrong")).toBe(true);

    // extensions.ndjson must log classification=blocking and MUST NOT contain raw secret value
    const extLogPath = join(session.records.directory, "extensions.ndjson");
    const content = readFileSync(extLogPath, "utf8");
    expect(content).toContain('"classification":"blocking"');
    expect(content).not.toContain("top-secret-token");

    await session.close();
  });

  it("Major 1: entry.server runnerLifecycle delegates recover and shutdown to acpRunnerRegistry", async () => {
    const entry = await import("../../app/entry.server.js");
    const { acpRunnerRegistry } = await import("../../app/lib/runner/acp-registry.server.js");
    const { runnerRegistry } = await import("../../app/lib/runner/registry.server.js");
    const recoverAcp = vi.spyOn(acpRunnerRegistry, "recover").mockResolvedValue();
    const recoverPty = vi.spyOn(runnerRegistry, "recover").mockResolvedValue();
    const shutdownAcp = vi.spyOn(acpRunnerRegistry, "shutdown").mockResolvedValue();
    const shutdownPty = vi.spyOn(runnerRegistry, "shutdown").mockResolvedValue();
    try {
      await entry.runnerLifecycle.recover();
      expect(recoverAcp).toHaveBeenCalledTimes(1);
      expect(recoverPty).toHaveBeenCalledTimes(1);

      await entry.runnerLifecycle.shutdown();
      expect(shutdownAcp).toHaveBeenCalledTimes(1);
      expect(shutdownPty).toHaveBeenCalledTimes(1);
    } finally {
      recoverAcp.mockRestore();
      recoverPty.mockRestore();
      shutdownAcp.mockRestore();
      shutdownPty.mockRestore();
    }
  });

  it("refuses to resume a checkpoint after switching runtime, even after the new adapter negotiates", async () => {
    const bin = join(root, "resume-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    symlinkSync(join(bin, "agy"), join(bin, "codex-acp"));
    const sessionId = "sess-agy-preserved";
    const startSession = vi.fn(async (adapter: AcpAdapter) => {
      const failed = adapter.displayName === "Codex ACP";
      let resolveExit!: () => void;
      return {
        state: { kind: failed ? "failed" : "idle" },
        negotiated: true,
        supportsResume: () => true,
        activeSessionId: failed ? undefined : sessionId,
        exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
        exitInfo: { code: 0, signal: null },
        close: async () => resolveExit(),
      } as unknown as AcpSession;
    });
    const reg = new AcpRunnerRegistry({ ...env, PATH: bin }, {
      listWindows: () => [],
      execVersion: () => ({ status: 0, stdout: "fixture 2.6.0", stderr: "" }),
      startSession,
    });

    await reg.start(agent);
    await reg.stop(agent);
    expect(reg.lastSessionId(agent)).toBe(sessionId);
    expect(reg.canResume(agent)).toBe(true);

    writeFileSync(join(home, ".runtime"), "codex\n");
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    expect(startSession).toHaveBeenCalledTimes(1);

    await expect(reg.start(agent)).rejects.toThrow(/negotiation ended/);
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(existsSync(lockFile)).toBe(false);
    expect(reg.lastSessionId(agent)).toBe(sessionId);

    writeFileSync(join(home, ".runtime"), "agy\n");
    expect(reg.canResume(agent)).toBe(true);

    const replacement = join(home, "replacement-checkpoint");
    writeFileSync(replacement, sessionId + "\n");
    renameSync(replacement, join(home, ".acp-last-session"));
    expect(reg.lastSessionId(agent)).toBe(sessionId);
    expect(reg.canResume(agent)).toBe(false);
  });

  it("keeps the previous resumable checkpoint if writing new evidence runs out of space", async () => {
    let sessionId = "previous-session";
    const reg = new AcpRunnerRegistry(env, {
      manifest: { ...antigravity1Manifest, executableName: fakeAgyScript },
      listWindows: () => [],
      execVersion: () => ({ status: 0, stdout: "1.5.14", stderr: "" }),
      startSession: async () => resumableSession(sessionId),
    });
    await reg.start(agent);
    await reg.stop(agent);
    expect(reg.canResume(agent)).toBe(true);

    sessionId = "new-session";
    const write = vi.mocked(writeSync);
    const realWrite = write.getMockImplementation()!;
    write.mockImplementation((...args) => {
      if (Buffer.isBuffer(args[1]) && args[1].includes('"supported":true')) {
        throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
      }
      return realWrite(...args);
    });
    try {
      expect((await reg.start(agent)).activeSessionId).toBe("new-session");
      await reg.stop(agent);
      expect(reg.lastSessionId(agent)).toBe("previous-session");
      expect(reg.canResume(agent)).toBe(true);
    } finally {
      write.mockReset();
    }
  });

  it.each(["legacy sidecar", "embedded evidence"])(
    "upgrades Antigravity checkpoints from %s and writes a rollback-compatible pair",
    async (format) => {
      const sessionId = " previous-session ";
      const idFile = join(home, ".acp-last-session");
      const sidecar = join(home, ".acp-capabilities");
      const { dev, ino, size, mtimeMs, sha256 } = statExecutableIdentity(fakeAgyScript);
      const legacyKey = `${dev}:${ino}:${size}:${mtimeMs}:${sha256}`;
      if (format === "legacy sidecar") {
        writeFileSync(idFile, sessionId + "\n");
        writeFileSync(sidecar, JSON.stringify({ supported: true, executableKey: legacyKey }));
      } else {
        const evidence = { supported: true, executableKey: `${antigravity1Manifest.name}:${legacyKey}` };
        writeFileSync(idFile, sessionId + "\n" + JSON.stringify(evidence) + "\n");
      }
      const startSession = vi.fn(async (_adapter: AcpAdapter, options: { resumeSessionId?: string }) => {
        expect(options.resumeSessionId).toBe(sessionId);
        return resumableSession(sessionId);
      });
      const reg = new AcpRunnerRegistry(env, {
        manifest: { ...antigravity1Manifest, executableName: fakeAgyScript },
        listWindows: () => [],
        execVersion: () => ({ status: 0, stdout: "1.5.14", stderr: "" }),
        startSession,
      });

      expect(reg.canResume(agent)).toBe(true);
      await reg.start(agent, { resume: true });
      await reg.stop(agent);
      expect(startSession).toHaveBeenCalledOnce();
      // These are the fields and literal session ID consumed by the base reader.
      expect(readFileSync(idFile, "utf8")).toBe(sessionId + "\n");
      expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
        supported: true, executableKey: legacyKey, checkpointKey: expect.any(String),
      });
      expect(reg.canResume(agent)).toBe(true);
    },
  );

  it("starts Codex through a shim without saving Resume evidence for an unresolved backend", async () => {
    writeFileSync(join(home, ".runtime"), "codex\n");
    writeFileSync(join(root, "codex-acp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const startSession = vi.fn(async () => resumableSession("unverified-codex-session"));
    const reg = new AcpRunnerRegistry({ ...env, PATH: root }, {
      listWindows: () => [],
      execVersion: () => ({ status: 0, stdout: "2.6.0", stderr: "" }),
      startSession,
    });
    expect((await reg.start(agent)).activeSessionId).toBe("unverified-codex-session");
    await reg.stop(agent);
    expect(reg.lastSessionId(agent)).toBeUndefined();
    expect(existsSync(join(home, ".acp-capabilities"))).toBe(false);
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    expect(startSession).toHaveBeenCalledOnce();
  });

  it("refuses Codex resume when the selected binary or session store changes", async () => {
    const wrapper = join(root, "codex-acp");
    const codex = join(root, "codex");
    const replacement = join(root, "other-codex");
    for (const file of [wrapper, codex, replacement]) {
      writeFileSync(file, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    writeFileSync(join(home, ".runtime"), "codex\n");
    const store = join(root, "codex-store");
    mkdirSync(store);
    env.PATH = root;
    env.CODEX_PATH = codex;
    env.CODEX_HOME = store;
    const startSession = vi.fn(async () => resumableSession("codex-session"));
    const reg = new AcpRunnerRegistry(env, {
      listWindows: () => [],
      execVersion: () => ({ status: 0, stdout: "2.6.0", stderr: "" }),
      startSession,
    });
    await reg.start(agent);
    await reg.stop(agent);
    expect(reg.canResume(agent)).toBe(true);

    env.CODEX_PATH = replacement;
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    env.CODEX_PATH = codex;
    expect(reg.canResume(agent)).toBe(true);

    env.CODEX_HOME = root;
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    env.CODEX_HOME = store;
    expect(reg.canResume(agent)).toBe(true);

    writeFileSync(join(store, "session.json"), "{}");
    expect(reg.canResume(agent)).toBe(true);
    const originalStore = join(root, "original-store");
    renameSync(store, originalStore);
    mkdirSync(store);
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    rmSync(store, { recursive: true });
    renameSync(originalStore, store);
    expect(reg.canResume(agent)).toBe(true);

    writeFileSync(codex, "#!/bin/sh\nexit 2\n");
    expect(reg.canResume(agent)).toBe(false);
    await expect(reg.start(agent, { resume: true })).rejects.toMatchObject({ reason: "start-failed" });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(reg.lastSessionId(agent)).toBe("codex-session");
  });

  it.runIf(["linux", "darwin"].includes(process.platform) && ["x64", "arm64"].includes(process.arch))(
    "refuses Codex resume after replacing the npm-bundled native binary",
    async () => {
      const platform = process.platform;
      const arch = process.arch;
      const target = `${arch === "x64" ? "x86_64" : "aarch64"}-${platform === "linux" ? "unknown-linux-musl" : "apple-darwin"}`;
      const packages = join(root, "node_modules", "@openai");
      const launcherDir = join(packages, "codex", "bin");
      const nativePackage = join(packages, `codex-${platform}-${arch}`);
      const nativeDir = join(nativePackage, "vendor", target, "bin");
      mkdirSync(launcherDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativePackage, "package.json"), "{}");
      writeFileSync(join(launcherDir, "codex.js"), "// bundled launcher\n");
      writeFileSync(join(root, "codex-acp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const native = join(nativeDir, "codex");
      writeFileSync(native, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      writeFileSync(join(home, ".runtime"), "codex\n");
      const reg = new AcpRunnerRegistry({ ...env, PATH: root }, {
        listWindows: () => [],
        execVersion: () => ({ status: 0, stdout: "2.6.0", stderr: "" }),
        startSession: async () => resumableSession("codex-session"),
      });
      await reg.start(agent);
      await reg.stop(agent);
      expect(reg.canResume(agent)).toBe(true);
      writeFileSync(native, "#!/bin/sh\nexit 20\n");
      expect(reg.canResume(agent)).toBe(false);
    },
  );
});
