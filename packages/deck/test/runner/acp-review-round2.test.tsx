import {
  chmodSync,
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
    // Printable leading/trailing spaces preserved on read AND retained after capability-downgrade refusal
    expect(regNoRes.lastSessionId(agent)).toBe("  spaced-id  ");
    await expect(regNoRes.start(agent, { resume: true })).rejects.toThrow(/does not support/);
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

    // Major 3b: explicit session-not-found (-32002 with matching data.sessionId) clears stale .acp-last-session
    const missingSessScript = join(root, "r5-notfound.mjs");
    writeFileSync(
      missingSessScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Session not found", data: { sessionId: "valid-saved-id" } } });
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

  it("Round 6 (Majors 1-4 & Minors 3-4): cross-socket tmux check, -32002 uri vs sessionId & pre-lock swap, blocker survives 501 chunks + disconnect, structured quota code, -32022 & severity:fatal", async () => {
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
    writeFileSync(join(agentHome, ".acp-last-session"), "keep-me-uri\n");
    const missingFileScript = join(root, "r6-uri.mjs");
    writeFileSync(
      missingFileScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Resource not found", data: { uri: "file:///missing" } } });
      `),
    );
    const regUri = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [missingFileScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await expect(regUri.start(agent, { resume: true })).rejects.toThrow();
    expect(regUri.lastSessionId(agent)).toBe("keep-me-uri");

    // Major 2b: Checkpoint replaced during pre-lock probe is NEVER deleted if old ID is rejected
    writeFileSync(join(agentHome, ".acp-last-session"), "old-pre-probe-id\n");
    const swapScript = join(root, "r6-swap.mjs");
    writeFileSync(
      swapScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (msg.method === "session/load") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Session not found", data: { sessionId: "old-pre-probe-id" } } });
      `),
    );
    const regSwap = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [swapScript] },
      execVersion: () => {
        writeFileSync(join(agentHome, ".acp-last-session"), "newer-valid-id\n");
        return { status: 0, stdout: "1.5.14\n", stderr: "" };
      },
      listWindows: () => [],
    });
    await expect(regSwap.start(agent, { resume: true })).rejects.toThrow();
    expect(regSwap.lastSessionId(agent)).toBe("newer-valid-id");

    // Major 3: Blocker + 501 chunks + disconnect retains the blocking card in stopped thread view
    const blockerDiscScript = join(root, "r6-blocker-disc.mjs");
    writeFileSync(
      blockerDiscScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-bd" } });
        else if (msg.method === "session/prompt") {
          for (let i = 1; i <= 17; i++) send({ jsonrpc: "2.0", id: i, method: "_ext/unsupported_req", params: {} });
          for (let i = 0; i < 501; i++) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-bd", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" + i } } } });
          setTimeout(() => process.exit(1), 30);
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
    await delay(80);
    expect(regDisc.status(agent)?.state).toBe("stopped");
    expect(regDisc.events(agent).some((e) => e.type === "extension.blocking")).toBe(true);

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

    // Round 9 Major 1: Explicit .base-tmux-socket + grouped sessions (`list-windows -a`) + usual-dir scan when absent
    const tmuxStubDir = join(root, "tmux-stub-bin");
    mkdirSync(tmuxStubDir, { recursive: true });
    const privateSockDir = join(root, "private-tmux-dir");
    const uidDir = join(privateSockDir, `tmux-${process.getuid?.() ?? 1000}`);
    mkdirSync(uidDir, { recursive: true });
    const recordedSock = join(uidDir, "base-explicit");
    writeFileSync(recordedSock, "stub-sock");
    const stubTmuxPath = join(tmuxStubDir, "tmux");
    writeFileSync(
      stubTmuxPath,
      `#!/usr/bin/env bash
sock=""
if [[ "$1" == "-S" ]]; then
  sock="$2"
  shift 2
fi
if [[ "$1" == "list-windows" && "$2" == "-a" ]]; then
  if [[ "$sock" == "${recordedSock}" ]]; then
    echo "${agent}"
    exit 0
  fi
  echo "no server running on /tmp/tmux-0/default" >&2
  exit 1
fi
echo "can't find session: agents" >&2
exit 1
`,
    );
    chmodSync(stubTmuxPath, 0o755);
    // Case A: .base-tmux-socket points to recordedSock (grouped session only; -t agents fails) -> refused!
    writeFileSync(join(root, ".base-tmux-socket"), `${recordedSock}\n`);
    const regExplicitSock = new AcpRunnerRegistry(
      { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: `${tmuxStubDir}:${process.env.PATH ?? ""}` },
      {
        dataRoot: root,
        manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [slowCloseScript] },
        execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      },
    );
    await expect(regExplicitSock.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Case B: .base-tmux-socket ABSENT, socket exists in TMUX_TMPDIR/tmux-<uid>/ -> discovered & refused!
    rmSync(join(root, ".base-tmux-socket"), { force: true });
    const regFallbackScan = new AcpRunnerRegistry(
      {
        AGENTS_HOME: root,
        MC_ACP_RUNNER: "1",
        HOME: root,
        TMUX_TMPDIR: privateSockDir,
        PATH: `${tmuxStubDir}:${process.env.PATH ?? ""}`,
      },
      {
        dataRoot: root,
        manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [slowCloseScript] },
        execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      },
    );
    await expect(regFallbackScan.start(agent)).rejects.toMatchObject({ name: "StartRefusal", reason: "tmux-active" });

    // Round 9 Minor 1: Capability-gated Resume (canResume turns false after downgraded refusal, UI hides Resume button)
    const downgradedScript = join(root, "r9-downgraded.mjs");
    writeFileSync(
      downgradedScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-dg" } });
      `),
    );
    writeFileSync(join(agentHome, ".acp-last-session"), "kept-valid-checkpoint\n");
    const regCapGate = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [downgradedScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    await expect(regCapGate.start(agent, { resume: true })).rejects.toThrow();
    expect(regCapGate.lastSessionId(agent)).toBe("kept-valid-checkpoint");
    expect(regCapGate.canResume(agent)).toBe(false);
    const hiddenResumeHtml = renderToStaticMarkup(
      <AcpThreadView
        agent={agent}
        initialStatus={{ state: "stopped" }}
        initialEvents={[]}
        initialLastSessionId="kept-valid-checkpoint"
        initialCanResume={false}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );
    expect(hiddenResumeHtml).not.toContain("Resume last session");

    // Round 9 Minor 2: Non-blocking unknown advisory notification goes to extensions.ndjson ONLY, never raw.ndjson
    const advScript = join(root, "r9-advisory.mjs");
    writeFileSync(
      advScript,
      byteIoScript(`
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-adv" } });
        else if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "vendor/notice", params: { secretToken: "ADV_SECRET_TOKEN_99" } });
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
    const rawLog = readFileSync(join(advSess.records.directory, "raw.ndjson"), "utf8");
    expect(extLog).toContain("vendor/notice");
    expect(extLog).not.toContain("ADV_SECRET_TOKEN_99");
    expect(rawLog).not.toContain("ADV_SECRET_TOKEN_99");
    expect(rawLog).not.toContain("vendor/notice");
  });
});
