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
import { action as acpAction } from "../../app/routes/api.acp.js";

function byteIoScript(handlerBody: string): string {
  return `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
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

    // Major 3b: stale .acp-last-session is cleared when a non-resume agent starts
    writeFileSync(join(agentHome, ".acp-last-session"), "stale-session-id\n");
    await reg.start(agent);
    expect(reg.lastSessionId(agent)).toBeUndefined();
    await reg.stop(agent);

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

    // Major 3: Refused Resume (agent dropped resume capability) clears stale .acp-last-session
    writeFileSync(join(agentHome, ".acp-last-session"), "  spaced-id  \n");
    const noResScript = join(root, "r4-nores.mjs");
    writeFileSync(
      noResScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      `),
    );
    const regNoRes = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [noResScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    // Printable leading/trailing spaces preserved on read
    expect(regNoRes.lastSessionId(agent)).toBe("  spaced-id  ");
    await expect(regNoRes.start(agent, { resume: true })).rejects.toThrow(/does not support/);
    expect(regNoRes.lastSessionId(agent)).toBeUndefined();

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
    writeFileSync(join(agentHome, ".acp-last-session"), "valid-saved-id\n");
    const protoMismatchScript = join(root, "r5-proto.mjs");
    writeFileSync(
      protoMismatchScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 99, agentCapabilities: { loadSession: true } } });
      `),
    );
    const regProto = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [protoMismatchScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await expect(regProto.start(agent, { resume: true })).rejects.toThrow();
    expect(regProto.lastSessionId(agent)).toBe("valid-saved-id");

    // Major 3b: explicit session-not-found from loadSession clears stale .acp-last-session
    const missingSessScript = join(root, "r5-notfound.mjs");
    writeFileSync(
      missingSessScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Session not found" } });
      `),
    );
    const regNotFound = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [missingSessScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await expect(regNotFound.start(agent, { resume: true })).rejects.toThrow();
    expect(regNotFound.lastSessionId(agent)).toBeUndefined();

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
});
