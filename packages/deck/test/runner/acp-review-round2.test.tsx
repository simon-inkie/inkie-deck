import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpThreadView } from "../../app/components/AcpThreadView.js";
import { AcpSession, MAX_QUEUED_PROMPTS, PromptQueueFullError } from "../../app/lib/acp-session.server.js";
import type { DeckEvent } from "../../app/lib/deck-event.js";
import {
  antigravity1Manifest,
  antigravityUsageReading,
  probeAgyVersion,
  sanitizePathEnv,
} from "../../app/lib/runner/acp-manifest.js";
import { AcpRunnerRegistry, acpRunnerRegistry } from "../../app/lib/runner/acp-registry.server.js";
import { RunnerRegistry } from "../../app/lib/runner/registry.server.js";
import { hasSameOriginProof } from "../../app/lib/request-origin.server.js";
import { action as acpAction } from "../../app/routes/api.acp.js";

function byteIoScript(handlerBody: string): string {
  return `
import { createReadStream, createWriteStream } from "node:fs";
let buf = "";
const input = createReadStream(null, { fd: 0, encoding: "utf8" });
const output = createWriteStream(null, { fd: 1 });
input.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const send = (obj) => output.write(JSON.stringify(obj) + "\\n");
    ${handlerBody}
  }
});
`;
}

describe("ACP Slice 2 Round 2 Hardening (All 11 Majors + Minors 1 & 2)", () => {
  let root: string;
  let agentHome: string;
  const agent = "acp-r2-agent";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deck-acp-r2-"));
    agentHome = join(root, agent);
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(agentHome, ".runner"), "acp\n");
    writeFileSync(join(agentHome, ".runtime"), "agy\n");
  });

  afterEach(async () => {
    await acpRunnerRegistry.stop(agent).catch(() => {});
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("checks the default agents session and ignores a window on another tmux socket", async () => {
    const shimBin = join(root, "tmux-shim-bin");
    mkdirSync(shimBin);
    const defaultWindow = join(root, "base-window");
    const shimLog = join(root, "tmux-shim.log");
    writeFileSync(defaultWindow, "");
    writeFileSync(
      join(shimBin, "tmux"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(shimLog)}
if [[ "$*" == *"list-windows"* ]]; then
  if [[ -n "\${TMUX:-}\${TMUX_PANE:-}\${TMUX_TMPDIR:-}" || "$1" == "-S" ||
        "$3" != "=agents" || -f ${JSON.stringify(defaultWindow)} ]]; then
    printf '%s\\n' ${agent}
  fi
fi
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${shimBin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("TMUX", `${root}/other.sock,999,0`);
    vi.stubEnv("TMUX_PANE", "%2");
    vi.stubEnv("TMUX_TMPDIR", root);
    const env = {
      ...process.env,
      AGENTS_HOME: root,
      MC_ACP_RUNNER: "1",
      MC_TMUX_SESSION: "personal",
      BASE_TMUX_SOCKET: join(root, "other.sock"),
      HOME: root,
    };
    const registry = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: {
        ...antigravity1Manifest,
        executableName: process.execPath,
        args: [fileURLToPath(new URL("../fixtures/acp-agent.mjs", import.meta.url)), "{}"],
      },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
    });
    const { sendNamedKeyToWindow } = await import("../../app/lib/tmux.server.js");
    expect(sendNamedKeyToWindow({ ...env, MC_TMUX_SESSION: "agents" }, agent, "Enter")).toEqual({ ok: true });
    expect(readFileSync(shimLog, "utf8").trim().split("\n")).toEqual([
      "list-windows -t =agents -F #{window_name}",
      `send-keys -t =agents:=${agent} Enter`,
    ]);
    await expect(registry.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Only the other socket or session still has the window.
    rmSync(defaultWindow);
    writeFileSync(shimLog, "");
    const session = await registry.start(agent);
    try {
      expect(session.state.kind).toBe("idle");
      expect(readFileSync(shimLog, "utf8").trim().split("\n")).toEqual([
        "list-windows -t =agents -F #{window_name}",
        "list-windows -t =agents -F #{window_name}",
      ]);
    } finally {
      await registry.stop(agent);
    }
  });

  it("refuses a Base window that appears only after claiming the ACP lock", async () => {
    const lockFile = join(agentHome, ".runner.lock");
    const listWindows = vi.fn(() => existsSync(lockFile) ? [agent] : []);
    const startSession = vi.fn(async () => { throw new Error("Unexpected ACP spawn"); });
    const registry = new AcpRunnerRegistry(
      { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH },
      {
        dataRoot: root,
        manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [] },
        execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
        listWindows,
        startSession,
      },
    );
    await expect(registry.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });
    expect(listWindows).toHaveBeenCalledTimes(2);
    expect(startSession).not.toHaveBeenCalled();
    expect(existsSync(lockFile)).toBe(false);
  });

  it.runIf(process.platform === "linux")("recovers a stale ACP lock after opting out before Deck restarts", async () => {
    const lockFile = join(agentHome, ".runner.lock");
    const baseHome = join(root, "base-agent");
    const baseLock = join(baseHome, ".runner.lock");
    mkdirSync(baseHome);
    const staleClaim = {
      deckPid: 100,
      deckBirth: "1",
      childPid: null,
      childBirth: null,
      bootId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      startedAt: 1,
      phase: "reserved",
    };
    writeFileSync(lockFile, JSON.stringify({ ...staleClaim, owner: "acp" }), { mode: 0o600 });
    writeFileSync(baseLock, JSON.stringify({ ...staleClaim, owner: "base" }), { mode: 0o600 });
    rmSync(join(agentHome, ".runner"));

    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1" };
    const ptyRegistry = new RunnerRegistry(env);
    const acpRegistry = new AcpRunnerRegistry(env);
    expect(acpRegistry.status(agent)).toBeUndefined();
    await ptyRegistry.recover();
    expect(existsSync(lockFile)).toBe(true);
    await acpRegistry.recover();
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(baseLock)).toBe(true);
  });

  it("Major 1: fatal extension terminates session, closes open permissions, and refuses second prompt", async () => {
    const script = join(root, "fatal-ext.mjs");
    writeFileSync(
      script,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-fatal" } });
        } else if (msg.method === "session/prompt") {
          send({
            jsonrpc: "2.0", id: 77, method: "session/request_permission",
            params: { sessionId: "s-fatal", toolCall: { toolCallId: "t1", title: "Write" }, options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }] }
          });
          setTimeout(() => {
            send({ jsonrpc: "2.0", method: "_ext/fatal", params: { why: "boom" } });
          }, 30);
        }
      `),
    );

    const events: DeckEvent[] = [];
    const session = await AcpSession.start(
      { executable: process.execPath, args: [script], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => events.push(e) },
    );

    const outcome = await session.prompt("first turn");
    expect(outcome).toBe("failed");
    expect(session.state.kind).toBe("failed");

    // Open permission was closed by teardown
    const req = events.find((e) => e.type === "permission.requested");
    expect(req).toBeDefined();
    expect(events.some((e) => e.type === "permission.answered" && e.answers === req!.id)).toBe(true);
    expect(session.answerPermission(req!.id, "any")).toBe(false);

    // Second prompt MUST NOT go over wire; resolves immediately as failed
    expect(await session.prompt("second turn")).toBe("failed");
    await session.close();
  });

  it("Major 2: pending permission survives 505 message chunks without eviction, and UI closes buttons when not running", async () => {
    const script = join(root, "flood-perm.mjs");
    writeFileSync(
      script,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-flood" } });
        } else if (msg.method === "session/prompt") {
          send({
            jsonrpc: "2.0", id: 55, method: "session/request_permission",
            params: { sessionId: "s-flood", toolCall: { toolCallId: "t1", title: "Danger" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] }
          });
          for (let i = 0; i < 505; i++) {
            send({
              jsonrpc: "2.0", method: "session/update",
              params: { sessionId: "s-flood", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" + i } } }
            });
          }
        }
      `),
    );

    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [script] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });

    const session = await reg.start(agent);
    void session.prompt("flood test");
    await delay(200);

    const visibleEvents = reg.events(agent);
    expect(visibleEvents.some((e) => e.type === "permission.requested")).toBe(true);

    // UI disables permission buttons when status is stopped/disconnected AND shows Retry cleanup in cleanup-pending
    const permEv = visibleEvents.find((e) => e.type === "permission.requested")!;
    const stoppedHtml = renderToStaticMarkup(
      <AcpThreadView
        agent={agent}
        initialStatus={{ state: "stopped" }}
        initialEvents={[permEv]}
        initialLastSessionId={null}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );
    expect(stoppedHtml).toContain("Closed");
    expect(stoppedHtml).not.toContain(">Allow<");

    const cleanupHtml = renderToStaticMarkup(
      <AcpThreadView
        agent={agent}
        initialStatus={{ state: "cleanup-pending" }}
        initialEvents={[]}
        initialLastSessionId={null}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );
    expect(cleanupHtml).toContain("Retry cleanup");

    await reg.stop(agent);
  });

  it("Major 3 & 4: non-resume agent refuses resume & writes no .acp-last-session; loadSession preserves replay; symlink .acp-last-session never overwritten", async () => {
    // 1. Agent without resume/load capability
    const noResumeScript = join(root, "no-resume.mjs");
    writeFileSync(
      noResumeScript,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-no-res" } });
        }
      `),
    );

    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [noResumeScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });

    await reg.start(agent);
    expect(existsSync(join(agentHome, ".acp-last-session"))).toBe(false);
    await reg.stop(agent);

    // Explicit resumeSessionId on non-resume agent must become 'unsupported', NEVER fall back to session/new
    const unsupportedSess = await AcpSession.start(
      { executable: process.execPath, args: [noResumeScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, resumeSessionId: "old-sess" },
    );
    expect(unsupportedSess.state.kind).toBe("unsupported");
    await unsupportedSess.close();

    // 2. session/load sending replay updates BEFORE load response must retain replay transcript
    const loadReplayScript = join(root, "load-replay.mjs");
    writeFileSync(
      loadReplayScript,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === "session/load") {
          send({
            jsonrpc: "2.0", method: "session/update",
            params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED_HISTORY_LINE" } } }
          });
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      `),
    );

    const replayEvents: DeckEvent[] = [];
    const loadedSess = await AcpSession.start(
      { executable: process.execPath, args: [loadReplayScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, resumeSessionId: "s-replay-99", onEvent: (e) => replayEvents.push(e) },
    );
    expect(loadedSess.state.kind).toBe("idle");
    expect(replayEvents.some((e) => e.view.kind === "text" && e.view.excerpt === "REPLAYED_HISTORY_LINE")).toBe(true);
    await loadedSess.close();

    // 3. Major 4: symlink .acp-last-session pointing outside home MUST NOT be truncated/overwritten
    const outsideTarget = join(root, "outside-precious.txt");
    writeFileSync(outsideTarget, "DO_NOT_TRUNCATE");
    symlinkSync(outsideTarget, join(agentHome, ".acp-last-session"));

    const resumeCapScript = join(root, "res-cap.mjs");
    writeFileSync(
      resumeCapScript,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-new-id" } });
        }
      `),
    );
    const reg2 = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [resumeCapScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await reg2.start(agent);
    await reg2.stop(agent);
    expect(readFileSync(outsideTarget, "utf8")).toBe("DO_NOT_TRUNCATE");
  });

  it("Major 5: confirmed failed exec (missing interpreter, no PID) releases .runner.lock cleanly instead of stranding", async () => {
    const brokenExec = join(root, "broken-interp");
    writeFileSync(brokenExec, "#!/nonexistent/interp/does-not-exist\necho hi\n", { mode: 0o755 });

    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: brokenExec, args: [] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });

    await expect(reg.start(agent)).rejects.toThrow();
    expect(existsSync(join(agentHome, ".runner.lock"))).toBe(false);
  });

  it("Major 6, 7 & 8: probe aborts on AbortSignal; opt-out mid-probe refuses Start; unrelated malformed PTY home does not block ACP", async () => {
    // Major 6: slow version probe aborts fast on AbortSignal (<500ms instead of 5000ms)
    const slowProbe = join(root, "slow-probe");
    writeFileSync(slowProbe, "#!/bin/sh\nsleep 10\necho 1.5.14\n", { mode: 0o755 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const t0 = Date.now();
    await expect(probeAgyVersion(slowProbe, "1.5.0", { cwd: root, signal: ac.signal })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);

    // Major 7: switching .runner to tmux during version probe refuses Start and releases lock
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [] },
      execVersion: () => {
        writeFileSync(join(agentHome, ".runner"), "tmux\n");
        return { status: 0, stdout: "1.5.14\n", stderr: "" };
      },
      listWindows: () => [],
    });
    await expect(reg.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "not-opted-in" });
    expect(existsSync(join(agentHome, ".runner.lock"))).toBe(false);

    // Restore ACP opt-in; create an unrelated PTY home with a malformed .runner.lock (Major 8)
    writeFileSync(join(agentHome, ".runner"), "acp\n");
    const ptyHome = join(root, "unrelated-pty");
    mkdirSync(ptyHome, { recursive: true });
    writeFileSync(join(ptyHome, ".runner"), "pty\n");
    writeFileSync(join(ptyHome, ".runner.lock"), "{corrupt-json");

    const okScript = join(root, "ok-agent.mjs");
    writeFileSync(
      okScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-ok" } });
      `),
    );
    const regClean = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [okScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await regClean.recover();
    const s = await regClean.start(agent);
    expect(s.activeSessionId).toBe("s-ok");
    await regClean.stop(agent);
  });

  it("Major 9, 10, 11 & Minors 1-2: PATH stripped, unknown sessionUpdate logged cleanly without sensitive keys, body/queue capped, missing protocolVersion=unsupported, generic quota error not exhausted", async () => {
    // Major 9: sanitizePathEnv strips relative PATH entries
    expect(sanitizePathEnv(".:./bin:/usr/bin:rel:/bin")).toBe("/usr/bin:/bin");

    // Major 10 + Minor 2: unknown sessionUpdate variant does not violate schema; sensitive keys omitted; generic quota unavailable not exhausted
    const uScript = join(root, "unknown-update.mjs");
    writeFileSync(
      uScript,
      byteIoScript(`
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-u10" } });
        } else if (msg.method === "session/prompt") {
          for (let i = 0; i < 6; i++) {
            send({
              jsonrpc: "2.0", method: "session/update",
              params: { sessionId: "s-u10", update: { sessionUpdate: "future_progress_tick", "/etc/secret/path": "val" } }
            });
          }
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "quota endpoint unavailable" } });
        }
      `),
    );

    const events: DeckEvent[] = [];
    const sess = await AcpSession.start(
      { executable: process.execPath, args: [uScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => events.push(e) },
    );
    expect(await sess.prompt("run")).toBe("failed");
    // 6 unknown sessionUpdate variants must NOT kill session via violationLimit (5)!
    expect(sess.state.kind).toBe("settled");
    const extLog = readFileSync(join(sess.records.directory, "extensions.ndjson"), "utf8");
    expect(extLog).toContain("session/update:future_progress_tick");
    expect(extLog).toContain("object(keys:2)");
    expect(extLog).not.toContain("/etc/secret/path");
    // Minor 2: "quota endpoint unavailable" must NOT emit usage.exhausted
    expect(events.some((e) => e.type === "usage.exhausted")).toBe(false);
    await sess.close();

    // Minor 1: missing protocolVersion -> unsupported (not failed)
    const missingProtoScript = join(root, "missing-proto.mjs");
    writeFileSync(
      missingProtoScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: {} } });
      `),
    );
    const badProto = await AcpSession.start(
      { executable: process.execPath, args: [missingProtoScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(badProto.state.kind).toBe("unsupported");
    await badProto.close();

    // Major 11: prompt queue cap + 64 KiB body cap (HTTP 413)
    const hangScript = join(root, "hang-prompt.mjs");
    writeFileSync(
      hangScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-cap" } });
      `),
    );
    const capSess = await AcpSession.start(
      { executable: process.execPath, args: [hangScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) {
      void capSess.prompt(`msg-${i}`).catch(() => {});
    }
    await expect(capSess.prompt("overflow")).rejects.toThrow(PromptQueueFullError);
    await capSess.close();

    vi.stubEnv("AGENTS_HOME", root);
    vi.stubEnv("MC_ACP_RUNNER", "1");
    const hugeBody = JSON.stringify({ agent, op: "prompt", text: "x".repeat(70_000) });
    const hugeReq = new Request("http://127.0.0.1:4295/api/acp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4295", Host: "127.0.0.1:4295" },
      body: hugeBody,
    });
    const hugeRes = await acpAction({ request: hugeReq, params: {}, context: {} } as never);
    expect((hugeRes as { init?: ResponseInit }).init?.status).toBe(413);
  });

  it("Round 3 (Majors 1, 3, 4, 6): missing/stale resume, in-home symlink & hardlink protection, in-place rewrite refusal, and locked-start cancellation", async () => {
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const noResScript = join(root, "r3-nores.mjs");
    writeFileSync(
      noResScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-fresh" } });
      `),
    );

    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [noResScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });

    // Major 3a: resume: true with missing checkpoint fails fast instead of starting session/new
    await expect(reg.start(agent, { resume: true })).rejects.toThrow(/No valid saved session checkpoint/);

    // Major 2 (Round 8): fresh Start with a non-resume binary MUST PRESERVE a previously saved valid checkpoint
    // (checkpoints are cleared ONLY on explicit session-not-found for that exact ID).
    writeFileSync(join(agentHome, ".acp-last-session"), "valid-old-session-id\n");
    await reg.start(agent);
    expect(reg.lastSessionId(agent)).toBe("valid-old-session-id");
    await reg.stop(agent);
    rmSync(join(agentHome, ".acp-last-session"), { force: true });

    // Major 4: in-home symlink AND hard-linked .acp-last-session NEVER truncate their target file
    const inHomeTarget = join(agentHome, "precious-notes.txt");
    writeFileSync(inHomeTarget, "IN_HOME_SAFE");
    symlinkSync(inHomeTarget, join(agentHome, ".acp-last-session"));

    const resScript = join(root, "r3-res.mjs");
    writeFileSync(
      resScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-sym" } });
      `),
    );
    const regSym = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [resScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await regSym.start(agent);
    await regSym.stop(agent);
    expect(readFileSync(inHomeTarget, "utf8")).toBe("IN_HOME_SAFE");

    // Hard link to in-home file also refused without truncation
    rmSync(join(agentHome, ".acp-last-session"), { force: true });
    linkSync(inHomeTarget, join(agentHome, ".acp-last-session"));
    await regSym.start(agent);
    await regSym.stop(agent);
    expect(readFileSync(inHomeTarget, "utf8")).toBe("IN_HOME_SAFE");
    rmSync(join(agentHome, ".acp-last-session"), { force: true });

    // Major 6: in-place executable rewrite between probe and launch is refused
    const fakeBin = join(root, "mutable-agy");
    writeFileSync(fakeBin, "#!/bin/sh\necho 1.5.14\n", { mode: 0o755 });
    const regRewrite = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: fakeBin, args: [] },
      execVersion: () => {
        writeFileSync(fakeBin, "#!/bin/sh\necho 1.5.14\n# rewritten in place\n", { mode: 0o755 });
        return { status: 0, stdout: "1.5.14\n", stderr: "" };
      },
      listWindows: () => [],
    });
    await expect(regRewrite.start(agent)).rejects.toThrow(/changed between version probe and launch/);

    // Major 1: Stop cancels an in-flight Start even when target previously had 'locked' status
    writeFileSync(join(agentHome, ".runner.lock"), "{corrupt-json");
    await reg.recover();
    expect(reg.status(agent)?.state).toBe("locked");
    rmSync(join(agentHome, ".runner.lock"), { force: true });

    const slowProbe = join(root, "r3-slow-probe");
    writeFileSync(slowProbe, "#!/bin/sh\nsleep 10\necho 1.5.14\n", { mode: 0o755 });
    const regLocked = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: slowProbe, args: [] },
      listWindows: () => [],
    });
    const startP = regLocked.start(agent);
    await delay(60);
    await regLocked.stop(agent);
    await expect(startP).rejects.toThrow();
  });

  it("Round 3 (Majors 7 & 8): session/update:fatal terminates turn, recoverable stays non-blocking, duplicate RPC ID & permission cap enforced", async () => {
    // Major 8: session/update:fatal is fatal, while recoverable: true error notification is non-blocking
    const nestedFatalScript = join(root, "r3-nested-fatal.mjs");
    writeFileSync(
      nestedFatalScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-nf" } });
        else if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "_ext/error", params: { recoverable: true } });
          setTimeout(() => {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-nf", update: { sessionUpdate: "fatal", code: "x" } } });
          }, 20);
        }
      `),
    );
    const nfSess = await AcpSession.start(
      { executable: process.execPath, args: [nestedFatalScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(await nfSess.prompt("go")).toBe("failed");
    expect(nfSess.state.kind).toBe("failed");
    const extLog = readFileSync(join(nfSess.records.directory, "extensions.ndjson"), "utf8");
    expect(extLog).toContain('"extensionName":"_ext/error"');
    expect(extLog).toContain('"classification":"non-blocking"');
    expect(extLog).toContain('"extensionName":"session/update:fatal"');
    expect(extLog).toContain('"classification":"fatal"');
    await nfSess.close();

    // Major 7: unsupported request colliding with live permission RPC ID is rejected (violation), and permission flood is capped
    const floodPermScript = join(root, "r3-perm-cap.mjs");
    writeFileSync(
      floodPermScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-pc" } });
        else if (msg.method === "session/prompt") {
          // 1 live permission on id 10, then an unsupported request reusing id 10, then 22 more permissions exceeding cap + violationLimit
          send({ jsonrpc: "2.0", id: 10, method: "session/request_permission", params: { sessionId: "s-pc", toolCall: { toolCallId: "t0", title: "T" }, options: [{ optionId: "y", name: "Y", kind: "allow_once" }] } });
          send({ jsonrpc: "2.0", id: 10, method: "_ext/unknown_req", params: {} });
          for (let i = 11; i < 35; i++) {
            send({ jsonrpc: "2.0", id: i, method: "session/request_permission", params: { sessionId: "s-pc", toolCall: { toolCallId: "t" + i, title: "T" }, options: [{ optionId: "y", name: "Y", kind: "allow_once" }] } });
          }
        }
      `),
    );
    const capSess = await AcpSession.start(
      { executable: process.execPath, args: [floodPermScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(await capSess.prompt("flood")).toBe("failed");
    expect(capSess.state.kind).toBe("failed");
    await capSess.close();
  });

  it("Round 4 (Majors 3, 4, 5, 6, 7): refused Resume clears stale checkpoint, same-size mtime-preserving rewrite refused via SHA-256, warning vs fatal request, bounded unknown request cards", async () => {
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };

    // Major 2 (Round 7): Refused Resume due to capability downgrade PRESERVES valid .acp-last-session
    // (only an explicit session-not-found for that exact ID clears the saved checkpoint).
    const noResScript = join(root, "r4-nores.mjs");
    const downgradeMarker = join(root, "r4-downgrade");
    writeFileSync(
      noResScript,
      'import { existsSync } from "node:fs";\n' + byteIoScript(`
        const loadSession = !existsSync(${JSON.stringify(downgradeMarker)});
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "  spaced-id  " } });
      `),
    );
    const regNoRes = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [noResScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await regNoRes.start(agent);
    await regNoRes.stop(agent);
    expect(regNoRes.canResume(agent)).toBe(true);
    writeFileSync(downgradeMarker, "");
    // Printable leading/trailing spaces survive the capability downgrade.
    expect(regNoRes.lastSessionId(agent)).toBe("  spaced-id  ");
    await expect(regNoRes.start(agent, { resume: true })).rejects.toMatchObject({ reason: "unavailable" });
    expect(regNoRes.canResume(agent)).toBe(false);
    expect(regNoRes.lastSessionId(agent)).toBe("  spaced-id  ");
    rmSync(join(agentHome, ".acp-last-session"), { force: true });

    // Major 5: Same-size rewrite preserving EXACT integer-second timestamp is caught by SHA-256 identity pin
    const fakeBin = join(root, "r4-same-size-bin");
    const fixedTime = new Date("2026-11-22T00:00:00.000Z");
    writeFileSync(fakeBin, "#!/bin/sh\necho 1.5.14 # AAAA\n", { mode: 0o755 });
    utimesSync(fakeBin, fixedTime, fixedTime);
    const regHash = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: fakeBin, args: [] },
      execVersion: () => {
        writeFileSync(fakeBin, "#!/bin/sh\necho 1.5.14 # BBBB\n", { mode: 0o755 });
        utimesSync(fakeBin, fixedTime, fixedTime);
        return { status: 0, stdout: "1.5.14\n", stderr: "" };
      },
      listWindows: () => [],
    });
    await expect(regHash.start(agent)).rejects.toThrow(/changed between version probe and launch/);

    // Major 6 & 7: advisory warning stays non-blocking, repeated unknown requests bound display.ndjson at 16
    // while ALWAYS keeping latest blocking card visible in UI, and fatal:true request terminates turn
    const extScript = join(root, "r4-ext.mjs");
    writeFileSync(
      extScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-r4" } });
        else if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "_ext/error", params: { severity: "warning" } });
          for (let i = 100; i < 125; i++) {
            send({ jsonrpc: "2.0", id: i, method: "_ext/unsupported_req", params: {} });
          }
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      `),
    );
    const extEvents: DeckEvent[] = [];
    const extSess = await AcpSession.start(
      { executable: process.execPath, args: [extScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => extEvents.push(e) },
    );
    expect(await extSess.prompt("advisory and 25 unknown reqs")).toBe("completed");
    // All 25 blocking requests reach live onEvent (never suppressed!), while display.ndjson caps at 16 blocking writes
    expect(extEvents.filter((e) => e.type === "extension.blocking").length).toBe(25);
    const displayLines = readFileSync(join(extSess.records.directory, "display.ndjson"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"extension.blocking"'));
    expect(displayLines.length).toBe(16);
    await extSess.close();

    // Fatal request (has id AND fatal: true) terminates turn instead of hanging pending
    const fatalReqScript = join(root, "r4-fatal-req.mjs");
    writeFileSync(
      fatalReqScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-fr" } });
        else if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", id: 999, method: "_ext/abort_req", params: { fatal: true } });
        }
      `),
    );
    const frSess = await AcpSession.start(
      { executable: process.execPath, args: [fatalReqScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(await frSess.prompt("fatal req")).toBe("failed");
    expect(frSess.state.kind).toBe("failed");
    await frSess.close();
  });

  it("Round 5 (Majors 1, 3, 4, 5): alternate MC_TMUX_SESSION still checks Base 'agents' session, Resume preserves valid checkpoint on proto mismatch and clears on session-not-found, rate-limit endpoint outage is not exhaustion", async () => {
    // Major 1: MC_TMUX_SESSION=separate still queries Base's "agents" session and refuses Start if agent is live there
    const altEnv = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", MC_TMUX_SESSION: "separate", HOME: root, PATH: process.env.PATH };
    const regAlt = new AcpRunnerRegistry(altEnv, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: (e) => (e.MC_TMUX_SESSION === "agents" ? [agent] : []),
    });
    await expect(regAlt.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Major 3a: temporary protocol mismatch preserves valid .acp-last-session
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const protoMismatchScript = join(root, "r5-proto.mjs");
    const protocolMarker = join(root, "r5-protocol-mismatch");
    writeFileSync(
      protoMismatchScript,
      'import { existsSync } from "node:fs";\n' + byteIoScript(`
        const protocolVersion = existsSync(${JSON.stringify(protocolMarker)}) ? 99 : 1;
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "valid-saved-id" } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Session not found", data: { sessionId: "valid-saved-id" } } });
      `),
    );
    const regProto = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [protoMismatchScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await regProto.start(agent);
    await regProto.stop(agent);
    writeFileSync(protocolMarker, "");
    await expect(regProto.start(agent, { resume: true })).rejects.toMatchObject({ reason: "unavailable" });
    expect(regProto.lastSessionId(agent)).toBe("valid-saved-id");

    // Major 3b: explicit session-not-found (-32002 with matching data.sessionId) clears stale .acp-last-session
    rmSync(protocolMarker);
    await expect(regProto.start(agent, { resume: true })).rejects.toThrow();
    expect(regProto.lastSessionId(agent)).toBeUndefined();

    // Major 5: "Rate limit endpoint unavailable" (-32603) MUST NOT emit usage.exhausted
    const outageScript = join(root, "r5-outage.mjs");
    writeFileSync(
      outageScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-out" } });
        else if (msg.method === "session/prompt") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Rate limit endpoint unavailable" } });
      `),
    );
    const outEvents: DeckEvent[] = [];
    const outSess = await AcpSession.start(
      { executable: process.execPath, args: [outageScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => outEvents.push(e) },
    );
    expect(await outSess.prompt("check outage")).toBe("failed");
    expect(outEvents.some((e) => e.type === "usage.exhausted")).toBe(false);
    await outSess.close();
  });

  it("Round 6 (Majors 1-2): cross-socket tmux check, -32002 uri vs sessionId and pre-lock checkpoint swap", async () => {
    // Major 1: Deck runs inside private TMUX socket while Base runs on default socket (TMUX unset) -> refused as tmux-active
    const privSockEnv = {
      AGENTS_HOME: root,
      MC_ACP_RUNNER: "1",
      TMUX: "/tmp/private-deck-tmux.sock,1234,0",
      TMUX_PANE: "%1",
      HOME: root,
      PATH: process.env.PATH,
    };
    const regSock = new AcpRunnerRegistry(privSockEnv, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: (e) => (!e.TMUX && e.MC_TMUX_SESSION === "agents" ? [agent] : []),
    });
    await expect(regSock.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Major 2a: -32002 with data.uri (missing file, NOT missing session) preserves valid checkpoint
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const missingFileScript = join(root, "r6-uri.mjs");
    writeFileSync(
      missingFileScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "keep-me-uri" } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Resource not found", data: { uri: "file:///missing" } } });
      `),
    );
    const regUri = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [missingFileScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await regUri.start(agent);
    await regUri.stop(agent);
    await expect(regUri.start(agent, { resume: true })).rejects.toThrow(/negotiation ended/);
    expect(regUri.lastSessionId(agent)).toBe("keep-me-uri");

    // Major 2b: Checkpoint replaced during pre-lock probe is NEVER deleted if old ID is rejected
    const regSwap = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [missingFileScript] },
      execVersion: () => {
        writeFileSync(join(agentHome, ".acp-last-session"), "newer-valid-id\n");
        return { status: 0, stdout: "1.5.14\n", stderr: "" };
      },
      listWindows: () => [],
    });
    expect(regSwap.canResume(agent)).toBe(true);
    await expect(regSwap.start(agent, { resume: true })).rejects.toThrow(/cannot be resumed/);
    expect(regSwap.lastSessionId(agent)).toBe("newer-valid-id");
  });

  it("Round 6 (Majors 3-4 & Minors 3-4): blocker retention, structured quota code, -32022 and severity:fatal", async () => {
    // Major 3: Blocker + 501 chunks + disconnect retains the blocking card in stopped thread view
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const blockerDiscScript = join(root, "r6-blocker-disc.mjs");
    writeFileSync(
      blockerDiscScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-bd" } });
        else if (msg.method === "session/prompt") {
          for (let i = 1; i <= 17; i++) send({ jsonrpc: "2.0", id: i, method: "_ext/unsupported_req", params: {} });
          for (let i = 0; i < 501; i++) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-bd", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" + i } } } });
          // Flush the flood and disconnect even if a blocking stdin read is pending.
          output.end();
        }
      `),
    );
    const regDisc = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [blockerDiscScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    const discSess = await regDisc.start(agent);
    expect(await discSess.prompt("flood and disconnect")).toBe("disconnected");
    await vi.waitFor(() => expect(regDisc.status(agent)?.state).toBe("stopped"));
    const retainedEvents = regDisc.events(agent);
    expect(retainedEvents.some((e) =>
      e.type === "message.chunk" && e.view.kind === "text" && e.view.excerpt === "c500",
    )).toBe(true);
    expect(retainedEvents.some((e) => e.type === "extension.blocking")).toBe(true);

    // Major 4 & Minor 4: -32603 text-only rate-limit ambiguity emits NO exhaustion; { reason: provider_error, code: quota_exhausted } DOES; severity: fatal terminates turn
    const quotaScript = join(root, "r6-quota.mjs");
    writeFileSync(
      quotaScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-q" } });
        else if (msg.method === "session/prompt") {
          globalThis.__qn = (globalThis.__qn || 0) + 1;
          if (globalThis.__qn === 1) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Could not determine whether the rate limit reached its threshold" } });
          else if (globalThis.__qn === 2) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Provider failure", data: { reason: "provider_error", code: "quota_exhausted" } } });
          else send({ jsonrpc: "2.0", method: "vendor/notice", params: { severity: "fatal" } });
        }
      `),
    );
    const qEvents: DeckEvent[] = [];
    const qSess = await AcpSession.start(
      { executable: process.execPath, args: [quotaScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => qEvents.push(e) },
    );
    expect(await qSess.prompt("ambiguous text")).toBe("failed");
    expect(qEvents.filter((e) => e.type === "usage.exhausted")).toHaveLength(0);
    expect(await qSess.prompt("structured code")).toBe("failed");
    expect(qEvents.filter((e) => e.type === "usage.exhausted")).toHaveLength(1);
    expect(await qSess.prompt("fatal notice")).toBe("failed");
    expect(qSess.state.kind).toBe("failed");
    expect(qEvents.some((e) => e.type === "extension.blocking")).toBe(true);
    await qSess.close();

    // Minor 3 & Round 7 Minor 1: Explicit -32022 initialize error transitions to unsupported with bounded integer versions only
    const protoErrScript = join(root, "r6-proto-err.mjs");
    writeFileSync(
      protoErrScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "Unsupported version", data: { requested: 1, supported: [2] } } });
      `),
    );
    const protoSess = await AcpSession.start(
      { executable: process.execPath, args: [protoErrScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(protoSess.state.kind).toBe("unsupported");
    expect(protoSess.unsupportedReason).toContain("requested 1");
    expect(protoSess.unsupportedReason).toContain("supported: 2");
    await protoSess.close();

    const giantProtoScript = join(root, "r7-giant-proto.mjs");
    writeFileSync(
      giantProtoScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "bad", data: { requested: "x".repeat(16000), supported: ["y".repeat(4000)] } } });
      `),
    );
    const giantSess = await AcpSession.start(
      { executable: process.execPath, args: [giantProtoScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root },
    );
    expect(giantSess.state.kind).toBe("unsupported");
    expect(giantSess.unsupportedReason).toBe("Unsupported ACP protocol version.");
    await giantSess.close();

    // Round 8 Major 1: Deck with custom TMUX_TMPDIR still checks Base's canonical default socket (TMUX_TMPDIR stripped)
    const tmpdirEnv = {
      AGENTS_HOME: root,
      MC_ACP_RUNNER: "1",
      TMUX_TMPDIR: "/tmp/custom-deck-tmux-dir",
      HOME: root,
      PATH: process.env.PATH,
    };
    const regTmpdir = new AcpRunnerRegistry(tmpdirEnv, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: (e) => (!e.TMUX && !e.TMUX_TMPDIR && e.MC_TMUX_SESSION === "agents" ? [agent] : []),
    });
    await expect(regTmpdir.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Round 8 Major 3: ENOSPC on BOTH inbound AND outbound raw.ndjson STILL delivers -32601 reply AND extension.blocking to UI
    const rawFailScript = join(root, "r7-raw-enospc.mjs");
    writeFileSync(
      rawFailScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-enospc" } });
        else if (msg.method === "session/prompt") {
          globalThis.__promptId = msg.id;
          send({ jsonrpc: "2.0", id: 777, method: "_ext/unknown_under_enospc", params: {} });
        } else if (msg.id === 777 && msg.error && msg.error.code === -32601) {
          send({ jsonrpc: "2.0", id: globalThis.__promptId, result: { stopReason: "end_turn" } });
        }
      `),
    );
    const rawFailEvents: DeckEvent[] = [];
    const rawFailSess = await AcpSession.start(
      { executable: process.execPath, args: [rawFailScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => rawFailEvents.push(e) },
    );
    const origFrame = rawFailSess.records.frame.bind(rawFailSess.records);
    rawFailSess.records.frame = (dir, bytes, issue) => {
      const text = bytes.toString("utf8");
      if (text.includes("_ext/unknown_under_enospc") || (dir === "out" && text.includes("-32601"))) {
        const err = new Error("ENOSPC") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return origFrame(dir, bytes, issue);
    };
    expect(await rawFailSess.prompt("trigger unknown under inbound+outbound raw ENOSPC")).toBe("completed");
    expect(rawFailEvents.some((e) => e.type === "extension.blocking")).toBe(true);
    await rawFailSess.close();
  });

  it("Rounds 9-10 (Majors 1-4 & Minors 1-3): append-only Base sockets, personal/EACCES isolation, closing-server ALS, bounded shutdown retries, cold-boot capability cache, base64 raw check, malformed load reply", async () => {
    const agent = "alpha";
    const agentHome = join(root, agent);
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(agentHome, ".runner"), "acp\n");
    writeFileSync(join(agentHome, ".runtime"), "agy\n");
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };

    // Round 8 Major 4 & Round 9 Major 2:
    // (a) Concurrent shutdown() calls share ONE in-flight promise and reject new Starts immediately while draining.
    // (b) Permanent shutdown blocks Start until reopen() is called for a fresh Vite server instance.
    const slowCloseScript = join(root, "r9-slow-close.mjs");
    writeFileSync(
      slowCloseScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-slow" } });
      `),
    );
    const regRestart = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [slowCloseScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    const s1 = await regRestart.start(agent);
    let releaseSlowClose!: () => void;
    const origClose = s1.close.bind(s1);
    s1.close = async () => {
      await new Promise<void>((r) => { releaseSlowClose = r; });
      return origClose();
    };
    let close1Done = false;
    let close2Done = false;
    const pClose1 = regRestart.shutdown({ permanent: false }).then(() => { close1Done = true; });
    const pClose2 = regRestart.shutdown({ permanent: false }).then(() => { close2Done = true; });
    await delay(20);
    // Neither concurrent shutdown call may finish before ACP teardown completes, and Start MUST be refused mid-shutdown
    expect(close1Done).toBe(false);
    expect(close2Done).toBe(false);
    await expect(regRestart.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "shutting-down" });
    releaseSlowClose();
    await Promise.all([pClose1, pClose2]);
    expect(close1Done).toBe(true);
    expect(close2Done).toBe(true);
    expect(s1.state.kind).toBe("disconnected");

    // Permanent shutdown latches closing=true until reopen() is invoked for a fresh server
    await regRestart.shutdown({ permanent: true });
    await expect(regRestart.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "shutting-down" });
    regRestart.reopen();
    const s2 = await regRestart.start(agent);
    expect(s2.state.kind).toBe("idle");
    await regRestart.stop(agent);

    // Round 12 Majors 1 & 2: Base shares Deck's .runner.lock atomically via base-runner-exec.sh!
    // Verify BOTH directions with real OS processes:
    // (a) While Base wrapper holds .runner.lock (flock + LockRecord), Deck refuses Start ('locked')
    //     AND a second Base wrapper fails closed without overwriting .runner.lock.
    // (b) When Base wrapper exits cleanly, .runner.lock is removed and Deck Start succeeds (ignoring TMUX env).
    // (c) While Deck holds .runner.lock, Base wrapper fails closed and never runs the runtime.
    // (d) When .runner is 'acp', Base wrapper exits 0 without running the runtime or leaving .runner.lock.
    const { spawn: spawnChild, spawnSync: spawnChildSync } = await import("node:child_process");
    const baseExecScript = join(process.cwd(), "..", "base", "bin", "base-runner-exec.sh");
    const baseAgentHome = join(root, "base-shared");
    mkdirSync(baseAgentHome, { recursive: true });
    writeFileSync(join(baseAgentHome, ".runtime"), "agy\n");
    const baseReadyFile = join(root, "base-exec-ready");
    const baseChild = spawnChild(
      baseExecScript,
      [
        baseAgentHome,
        "--",
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(baseReadyFile)}, "ready"); setTimeout(() => {}, 15000);`,
      ],
      { stdio: "ignore" },
    );
    const baseExited = new Promise<number | null>((resolve) => baseChild.once("exit", (code) => resolve(code)));
    try {
      const waitDeadline = Date.now() + 5000;
      while (!existsSync(baseReadyFile) && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(baseReadyFile)).toBe(true);
      expect(existsSync(join(baseAgentHome, ".runner.lock"))).toBe(true);

      // Round 14 Major 1: Zero-wrapper exec means the pane's process IS node (never python3!)
      const runningComm = readFileSync(`/proc/${baseChild.pid}/comm`, "utf8").trim();
      expect(runningComm).not.toBe("python3");

      // Round 13 Major 2 + Round 14 Major 2: Healthy Base lock (owner: "base") MUST NOT hijack
      // tmux terminal dispatch BEFORE OR AFTER RunnerRegistry.recover(), and MUST NOT record 'locked'
      // in PTY registry or block a separate opted-in PTY agent!
      const ptyBetaHome = join(root, "pty-beta");
      mkdirSync(ptyBetaHome, { recursive: true });
      writeFileSync(join(ptyBetaHome, ".runner"), "pty\n");
      const ptyReg = new RunnerRegistry({ AGENTS_HOME: root, MC_PTY_RUNNER: "1", HOME: root, PATH: process.env.PATH });
      expect(ptyReg.handlesTerminal("base-shared")).toBe(false);
      await ptyReg.recover();
      expect(ptyReg.handlesTerminal("base-shared")).toBe(false);
      expect(ptyReg.status("base-shared")).toBeUndefined();
      expect(ptyReg.status("pty-beta")).toBeUndefined();

      // Round 13 Major 1: Direct Python base-runner-exec.sh preserves interactive TTY stdin (fd 0 -> child)
      const stdinHome = join(root, "stdin-agent");
      mkdirSync(stdinHome, { recursive: true });
      const stdinRun = spawnChildSync(
        baseExecScript,
        [stdinHome, "--", process.execPath, "-e", 'const fs=require("node:fs");process.stdout.write(fs.readFileSync(0,"utf8"));'],
        { input: "pane-input\n", encoding: "utf8" },
      );
      expect(stdinRun.status).toBe(0);
      expect(stdinRun.stdout).toBe("pane-input\n");

      // Round 13 Major 4: Dead-owner 'spawning' lock with childPid: null MUST NOT be unlinked by a second Base wrapper
      const staleSpawnHome = join(root, "stale-spawn-agent");
      mkdirSync(staleSpawnHome, { recursive: true });
      const bootIdNow = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      writeFileSync(
        join(staleSpawnHome, ".runner.lock"),
        JSON.stringify({
          owner: "base",
          deckPid: 999999,
          deckBirth: "1",
          childPid: null,
          childBirth: null,
          bootId: bootIdNow,
          sessionId: "00000000-0000-4000-8000-000000000099",
          startedAt: Date.now(),
          phase: "spawning",
        }) + "\n",
        { mode: 0o600 },
      );
      const staleSpawnRes = spawnChildSync(baseExecScript, [staleSpawnHome, "--", process.execPath, "-e", "process.exit(0)"]);
      expect(staleSpawnRes.status).not.toBe(0);
      expect(existsSync(join(staleSpawnHome, ".runner.lock"))).toBe(true);

      // Flip .runner=acp mid-run while Base still holds .runner.lock: Deck MUST refuse with 'locked'!
      writeFileSync(join(baseAgentHome, ".runner"), "acp\n");
      const regSharedLock = new AcpRunnerRegistry(
        {
          AGENTS_HOME: root,
          MC_ACP_RUNNER: "1",
          HOME: root,
          TMUX: "/nonexistent/forbidden/personal-socket,99999,0",
          PATH: process.env.PATH,
        },
        {
          dataRoot: root,
          manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [slowCloseScript] },
          execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
          listWindows: () => [],
        },
      );
      await expect(regSharedLock.start("base-shared")).rejects.toMatchObject({ name: "StartRefusal", reason: "locked" });

      // Second Base wrapper MUST fail closed and MUST NOT remove or overwrite .runner.lock
      const sideEffectFile = join(root, "second-base-must-not-run");
      const secondBase = spawnChildSync(
        baseExecScript,
        [baseAgentHome, "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(sideEffectFile)}, "bad")`],
      );
      expect(secondBase.status).not.toBe(0);
      expect(existsSync(sideEffectFile)).toBe(false);
      expect(existsSync(join(baseAgentHome, ".runner.lock"))).toBe(true);

      // Terminate Base runtime -> kernel releases flock automatically -> Deck Start reaps stale Base lock & succeeds!
      baseChild.kill("SIGTERM");
      await baseExited;

      const deckOwnedSess = await regSharedLock.start("base-shared");
      expect(deckOwnedSess.state.kind).toBe("idle");

      // While Deck holds .runner.lock (even if .runner is removed), Base wrapper MUST fail closed!
      rmSync(join(baseAgentHome, ".runner"), { force: true });
      const baseWhileDeckRuns = spawnChildSync(
        baseExecScript,
        [baseAgentHome, "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(sideEffectFile)}, "bad")`],
      );
      expect(baseWhileDeckRuns.status).not.toBe(0);
      expect(existsSync(sideEffectFile)).toBe(false);

      // Restore .runner=acp and stop Deck cleanly; Base wrapper with .runner=acp exits 0 without running runtime
      writeFileSync(join(baseAgentHome, ".runner"), "acp\n");
      await regSharedLock.stop("base-shared");
      const baseOptedOut = spawnChildSync(
        baseExecScript,
        [baseAgentHome, "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(sideEffectFile)}, "bad")`],
      );
      expect(baseOptedOut.status).toBe(0);
      expect(existsSync(sideEffectFile)).toBe(false);
      expect(existsSync(join(baseAgentHome, ".runner.lock"))).toBe(false);

      // Round 14 Major 4 + Round 16 Major 3: Inherited flock across exec + real fork() keeps Base claim
      // locked while a grandchild survives after the direct runtime exits (NO /proc scanning needed!);
      // BOTH recoverRunnerLock AND a second Base launch MUST refuse until the grandchild exits!
      const gcHome = join(root, "base-grandchild");
      mkdirSync(gcHome, { recursive: true });
      const gcPidFile = join(root, "gc.pid");
      const gcParent = spawnChild(
        baseExecScript,
        [
          gcHome,
          "--",
          "python3",
          "-c",
          `import os, time
pid = os.fork()
if pid == 0:
    time.sleep(15)
    os._exit(0)
with open(${JSON.stringify(gcPidFile)}, "w", encoding="utf-8") as f:
    f.write(str(pid))
os._exit(0)`,
        ],
        { stdio: "ignore" },
      );
      await new Promise<void>((resolve) => gcParent.once("exit", () => resolve()));
      const gcDeadline = Date.now() + 5000;
      while (!existsSync(gcPidFile) && Date.now() < gcDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
      try {
        const { recoverRunnerLock, readRunnerLockOwner } = await import("../../app/lib/runner/lock.server.js");
        await expect(recoverRunnerLock(join(gcHome, ".runner.lock"))).rejects.toThrow();
        const secondGcBase = spawnChildSync(baseExecScript, [gcHome, "--", process.execPath, "-e", "process.exit(0)"]);
        expect(secondGcBase.status).not.toBe(0);
        expect(existsSync(join(gcHome, ".runner.lock"))).toBe(true);

        // Once the grandchild exits, kernel releases flock and recoverRunnerLock reaps cleanly!
        process.kill(gcPid, "SIGKILL");
        const killWait = Date.now() + 3000;
        let recovered = false;
        while (Date.now() < killWait) {
          try {
            if ((await recoverRunnerLock(join(gcHome, ".runner.lock"))) === "recovered") {
              recovered = true;
              break;
            }
          } catch {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        expect(recovered).toBe(true);
        expect(existsSync(join(gcHome, ".runner.lock"))).toBe(false);

        // Round 14 Minor 1 + Round 16 Minor 1: Malformed {"owner":"base"} AND missing childPid/childBirth
        // locks are rejected identically by Deck, runtime-launch.sh, and codex-provider-switch
        const badOwnerHome = join(root, "malformed-base-owner");
        mkdirSync(badOwnerHome, { recursive: true });
        const runtimeLaunch = join(process.cwd(), "..", "base", "bin", "runtime-launch.sh");
        const providerSwitchScript = join(process.cwd(), "..", "base", "bin", "codex-provider-switch");
        const malformedPayloads = [
          { owner: "base" },
          {
            owner: "base",
            deckPid: process.pid,
            deckBirth: "1",
            bootId: bootIdNow,
            sessionId: "00000000-0000-4000-8000-000000000077",
            startedAt: Date.now(),
          },
        ];
        for (const badRec of malformedPayloads) {
          writeFileSync(join(badOwnerHome, ".runner.lock"), JSON.stringify(badRec) + "\n", { mode: 0o600 });
          expect(readRunnerLockOwner(join(badOwnerHome, ".runner.lock"))).toBe("unknown");
          const shellCheck = spawnChildSync("bash", ["-c", `AGENTS_HOME="$1" source "$2"; runner_lock_is_base_owned "$3"`, "check", root, runtimeLaunch, join(badOwnerHome, ".runner.lock")]);
          expect(shellCheck.status).not.toBe(0);
          const providerCheck = spawnChildSync("python3", [
            "-c",
            `import importlib.machinery, importlib.util, pathlib, sys
loader = importlib.machinery.SourceFileLoader("cps", sys.argv[1])
spec = importlib.util.spec_from_loader("cps", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
sys.exit(0 if mod.agent_opts_into_pty(pathlib.Path(sys.argv[2])) else 1)`,
            providerSwitchScript,
            badOwnerHome,
          ]);
          expect(providerCheck.status).toBe(0);
        }
      } finally {
        try { process.kill(gcPid, "SIGKILL"); } catch { /* ignore */ }
      }

      // Round 14 Major 6 + Round 16 Major 7: ACP stop() MUST NOT hang when exited never resolves
      // BOTH when isGroupStopped === false (EPERM) AND when isGroupStopped === true (open stdout pipe)
      for (const groupStoppedFlag of [false, true]) {
        const unkillName = groupStoppedFlag ? "open-pipe-agent" : "unkillable-agent";
        const unkillHome = join(root, unkillName);
        mkdirSync(unkillHome, { recursive: true });
        writeFileSync(join(unkillHome, ".runner"), "acp\n");
        writeFileSync(join(unkillHome, ".runtime"), "agy\n");
        const neverExited = new Promise<void>(() => {});
        const regUnkill = new AcpRunnerRegistry(
          { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH },
          {
            dataRoot: root,
            manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [slowCloseScript] },
            execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
            listWindows: () => [],
            startSession: async (_adapter, opts) => {
              opts.onBeforeSpawn?.();
              opts.onSpawn?.(process.pid);
              return {
                state: { kind: "idle" },
                capabilities: {},
                negotiated: true,
                activeSessionId: `s-${unkillName}`,
                queuedCount: 0,
                authRequired: false,
                resumeRejected: false,
                isGroupStopped: groupStoppedFlag,
                exited: neverExited,
                exitInfo: { code: null, signal: null },
                records: { list: () => [] },
                supportsResume: () => false,
                close: async () => {},
              } as unknown as AcpSession;
            },
          },
        );
        await regUnkill.start(unkillName);
        const stopStart = Date.now();
        await regUnkill.stop(unkillName);
        expect(Date.now() - stopStart).toBeLessThan(1000);
        expect(regUnkill.status(unkillName)?.state).toBe("orphaned");
        expect(existsSync(join(unkillHome, ".runner.lock"))).toBe(true);
        const regState = (globalThis as unknown as Record<symbol, { sessions: Map<string, unknown> }>)[Symbol.for("inkie-deck.acp.registry")]!;
        regState.sessions.delete(unkillHome);
        rmSync(join(unkillHome, ".runner.lock"), { force: true });
      }
    } finally {
      try { baseChild.kill("SIGKILL"); } catch { /* ignore */ }
    }

    // Round 10 Major 3: Closing Vite server rejects Start via per-server AsyncLocalStorage even when shared.closing === false
    const closingAlsKey = Symbol.for("inkie-deck.dev.server-closing-als");
    const g = globalThis as typeof globalThis & { [closingAlsKey]?: AsyncLocalStorage<() => boolean> };
    const als = g[closingAlsKey] ??= new AsyncLocalStorage<() => boolean>();
    await als.run(() => true, async () => {
      await expect(regRestart.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "shutting-down" });
    });

    // Round 11 Major 4: Persistent lock-release failure (replaced lock inode) MUST NOT hang shutdown(),
    // transitions to 'orphaned', closes lock fd, and leaves other homes available.
    const betaHome = join(root, "beta");
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(join(betaHome, ".runner"), "acp\n");
    writeFileSync(join(betaHome, ".runtime"), "agy\n");
    const persistSess = await regRestart.start(agent);
    const lockFile = join(agentHome, ".runner.lock");
    rmSync(lockFile, { force: true });
    writeFileSync(lockFile, JSON.stringify({ replaced: true }) + "\n");
    const shutdownStart = Date.now();
    await regRestart.shutdown({ permanent: false, cleanupRetryDelayMs: 10 });
    expect(Date.now() - shutdownStart).toBeLessThan(1500);
    expect(persistSess.state.kind).toBe("disconnected");
    expect(regRestart.status(agent)?.state).toBe("orphaned");
    await expect(regRestart.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "locked" });
    expect((await regRestart.start("beta")).state.kind).toBe("idle");
    await regRestart.stop("beta");

    // Round 12 Minor 1: Orphaned thread view hides Start/Resume, shows recovery reason, and offers Retry recovery
    const orphanedHtml = renderToStaticMarkup(
      <AcpThreadView
        agent={agent}
        initialStatus={{ state: "orphaned", reason: "Orphaned lock requires recovery." }}
        initialEvents={[]}
        initialLastSessionId="kept-valid-checkpoint"
        initialCanResume={true}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );
    expect(orphanedHtml).not.toContain(">Start<");
    expect(orphanedHtml).not.toContain("Resume last session");
    expect(orphanedHtml).toContain("Orphaned lock requires recovery.");
    expect(orphanedHtml).toContain("Retry recovery");

    // Round 12 Major 3: Unverifiable orphanIdentity stays orphaned even when .runner.lock is absent,
    // and other homes remain available.
    const sharedRegState = (globalThis as unknown as Record<symbol, { sessions: Map<string, Record<string, unknown>> }>)[Symbol.for("inkie-deck.acp.registry")]!;
    rmSync(lockFile, { force: true });
    sharedRegState.sessions.set(agentHome, {
      state: "orphaned",
      reason: "Unverifiable orphan still blocking.",
      orphanIdentity: { pid: process.pid, birth: null, sessionId: "00000000-0000-4000-8000-000000000001" },
    });
    await regRestart.recover();
    expect(regRestart.status(agent)?.state).toBe("orphaned");
    await expect(regRestart.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "locked" });
    expect((await regRestart.start("beta")).state.kind).toBe("idle");
    await regRestart.stop("beta");

    // Round 13 Minor 1: Orphaned home retains canControl() and recoverAgent() even after opting out of .runner=acp
    rmSync(join(agentHome, ".runner"), { force: true });
    expect(regRestart.canControl(agent)).toBe(true);
    await regRestart.recoverAgent(agent);
    expect(regRestart.status(agent)?.state).toBe("orphaned");
    writeFileSync(join(agentHome, ".runner"), "acp\n");

    // Cold-start 'locked' entry on alpha is isolated from beta
    sharedRegState.sessions.set(agentHome, { state: "locked", reason: "Unrecovered lock on cold start." });
    expect((await regRestart.start("beta")).state.kind).toBe("idle");
    await regRestart.stop("beta");

    await regRestart.recover();
    const betaSess = await regRestart.start("beta");
    expect(betaSess.state.kind).toBe("idle");
    await regRestart.stop("beta");

    // Round 11 Minor 1: Strictly positive fail-closed capability gate for Resume
    // (absent .acp-capabilities -> false; capable start -> true across cold restart; downgraded refusal -> false)
    const capHome = join(root, "cap-agent");
    mkdirSync(capHome, { recursive: true });
    writeFileSync(join(capHome, ".runner"), "acp\n");
    writeFileSync(join(capHome, ".runtime"), "agy\n");
    writeFileSync(join(capHome, ".acp-last-session"), "kept-valid-checkpoint\n");
    const downgradedScript = join(root, "r9-downgraded.mjs");
    writeFileSync(
      downgradedScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-dg" } });
      `),
    );
    const regCapGate = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [downgradedScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    // No capability record yet -> fail closed (false!)
    expect(regCapGate.canResume("cap-agent")).toBe(false);
    await expect(regCapGate.start("cap-agent", { resume: true })).rejects.toThrow();
    expect(regCapGate.lastSessionId("cap-agent")).toBe("kept-valid-checkpoint");
    expect(regCapGate.canResume("cap-agent")).toBe(false);
    const hiddenResumeHtml = renderToStaticMarkup(
      <AcpThreadView
        agent="cap-agent"
        initialStatus={{ state: "stopped" }}
        initialEvents={[]}
        initialLastSessionId="kept-valid-checkpoint"
        initialCanResume={false}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );
    expect(hiddenResumeHtml).not.toContain("Resume last session");

    // Round 11 Major 5 & Minor 3: Malformed session/load reply (result: 42) AND switched sessionId ({ sessionId: "different" })
    // both fail validation and NEVER reach idle or overwrite checkpoint!
    const badLoadScript = join(root, "r10-bad-load.mjs");
    writeFileSync(
      badLoadScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, result: 42 });
      `),
    );
    const badLoadSess = await AcpSession.start(
      { executable: process.execPath, args: [badLoadScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, resumeSessionId: "kept-valid-checkpoint" },
    );
    expect(badLoadSess.state.kind).not.toBe("idle");
    await badLoadSess.close();

    const switchIdScript = join(root, "r11-switch-id.mjs");
    writeFileSync(
      switchIdScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "different" } });
      `),
    );
    const switchSess = await AcpSession.start(
      { executable: process.execPath, args: [switchIdScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, resumeSessionId: "kept-valid-checkpoint" },
    );
    expect(switchSess.state.kind).not.toBe("idle");
    expect(switchSess.activeSessionId).toBe("kept-valid-checkpoint");
    await switchSess.close();

    // Round 11 Minor 3 & Round 12 Major 4: Scheme mismatch without Fetch Metadata is REJECTED,
    // while legitimate HTTPS-proxy writes with Sec-Fetch-Site: same-origin + Origin: https:// on internal http:// URL PASS!
    const schemeMismatchReq = new Request("https://deck.example.test/api/acp", {
      method: "POST",
      headers: {
        host: "deck.example.test",
        origin: "http://deck.example.test",
      },
    });
    expect(hasSameOriginProof(schemeMismatchReq, {})).toBe(false);

    const httpsProxyReq = new Request("http://deck.example.test/api/acp", {
      method: "POST",
      headers: {
        host: "deck.example.test",
        origin: "https://deck.example.test",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(hasSameOriginProof(httpsProxyReq, {})).toBe(true);

    // Round 11 Minor 2: Non-blocking unknown advisory notification AND unknown sessionUpdate go to
    // extensions.ndjson ONLY, never raw.ndjson (verified by decoding base64 `rec.bytes`!)
    const advScript = join(root, "r9-advisory.mjs");
    writeFileSync(
      advScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-adv" } });
        else if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "vendor/notice", params: { secretToken: "ADV_SECRET_TOKEN_99" } });
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-adv", update: { sessionUpdate: "vendor_hint", secretToken: "ADV_UPDATE_SECRET_88" } } });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      `),
    );
    const advRoot = join(root, "adv-records");
    mkdirSync(advRoot, { recursive: true });
    const advEvents: DeckEvent[] = [];
    const advSess = await AcpSession.start(
      { executable: process.execPath, args: [advScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: advRoot, onEvent: (e) => advEvents.push(e) },
    );
    expect(await advSess.prompt("send advisory")).toBe("completed");
    await advSess.close();
    expect(advEvents.some((e) => e.type === "extension.blocking")).toBe(false);
    const extLog = readFileSync(join(advSess.records.directory, "extensions.ndjson"), "utf8");
    const rawLines = readFileSync(join(advSess.records.directory, "raw.ndjson"), "utf8").trim().split("\n").filter(Boolean);
    const decodedRaw = rawLines.map((line) => {
      const rec = JSON.parse(line) as { bytes?: string };
      return rec.bytes ? Buffer.from(rec.bytes, "base64").toString("utf8") : "";
    }).join("\n");
    expect(decodedRaw).toContain("initialize");
    expect(extLog).toContain("vendor/notice");
    expect(extLog).toContain("session/update:vendor_hint");
    expect(extLog).not.toContain("ADV_SECRET_TOKEN_99");
    expect(extLog).not.toContain("ADV_UPDATE_SECRET_88");
    expect(decodedRaw).not.toContain("ADV_SECRET_TOKEN_99");
    expect(decodedRaw).not.toContain("ADV_UPDATE_SECRET_88");
    expect(decodedRaw).not.toContain("vendor/notice");
    expect(decodedRaw).not.toContain("vendor_hint");
  }, 15_000);
});
