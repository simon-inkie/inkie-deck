import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpThreadView, deriveAcpCards } from "../../app/components/AcpThreadView.js";
import { AcpSession } from "../../app/lib/acp-session.server.js";
import type { DeckEvent } from "../../app/lib/deck-event.js";
import { antigravity1Manifest, antigravityUsageReading } from "../../app/lib/runner/acp-manifest.js";
import { AcpRunnerRegistry, acpRunnerRegistry } from "../../app/lib/runner/acp-registry.server.js";
import { action as acpAction, loader as acpLoader } from "../../app/routes/api.acp.js";

function makeReq(method: string, url: string, body?: object, origin = "http://127.0.0.1:4295"): Request {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Host: "127.0.0.1:4295",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("ACP Slice 2 Steps 4 to 6: Negotiate, Prompt, Cards, Permissions, Cancel, Resume, Usage", () => {
  let root: string;
  let agentHome: string;
  const agent = "acp-step46-agent";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deck-acp-s46-"));
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

  it("Step 4: -32000 authentication required emits plain auth.required action card with agy acp --login", async () => {
    const authScript = join(root, "auth-err.mjs");
    writeFileSync(
      authScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );

    const events: DeckEvent[] = [];
    const session = await AcpSession.start(
      { executable: process.execPath, args: [authScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => events.push(e) },
    );

    expect(session.state.kind).toBe("failed");
    expect(session.authRequired).toBe(true);
    const authCard = events.find((e) => e.type === "auth.required");
    expect(authCard).toBeDefined();
    expect(authCard?.class).toBe("action");
    expect(authCard?.view).toEqual({
      kind: "text",
      excerpt: "Sign in with `agy acp --login` in a terminal.",
    });
    await session.close();
  });

  it("Step 4 & 6: usage_update emits context line, limit error emits usage.exhausted, and second prompt queues", async () => {
    const usageScript = join(root, "usage-agent.mjs");
    writeFileSync(
      usageScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let promptCount = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }
    }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-usage-1" } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    promptCount++;
    if (promptCount === 1) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-usage-1", update: { sessionUpdate: "usage_update", used: 4000, size: 100000 } }
      }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
      }, 60);
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: 429, message: "Rate limit exceeded" }
      }) + "\\n");
    }
  }
});
`,
      { mode: 0o755 },
    );

    const events: DeckEvent[] = [];
    const session = await AcpSession.start(
      { executable: process.execPath, args: [usageScript], version: "1.5.14" },
      { cwd: agentHome, dataRoot: root, onEvent: (e) => events.push(e) },
    );

    expect(session.supportsResume()).toBe(true);
    expect(session.usageReading().state).toBe("unknown");

    const p1 = session.prompt("first turn");
    const p2 = session.prompt("second turn");
    expect(session.queuedCount).toBeGreaterThanOrEqual(1);

    expect(await p1).toBe("completed");
    expect(await p2).toBe("failed");

    expect(session.contextUsage).toEqual({ used: 4000, size: 100000 });
    expect(events.some((e) => e.type === "usage.updated" && e.view.kind === "text" && e.view.excerpt.includes("4000 / 100000"))).toBe(true);
    expect(events.some((e) => e.type === "usage.exhausted" && e.class === "action")).toBe(true);
    await session.close();
  });

  it("Step 6: stores last session id in .acp-last-session (never .session-id) and gates resume on advertised capability", async () => {
    const resumeScript = join(root, "resume-agent.mjs");
    writeFileSync(
      resumeScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
    }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-persist-42" } }) + "\\n");
  } else if (msg.method === "session/resume") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );

    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [resumeScript] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });

    const s1 = await reg.start(agent);
    expect(s1.activeSessionId).toBe("sess-persist-42");
    expect(existsSync(join(agentHome, ".acp-last-session"))).toBe(true);
    expect(existsSync(join(agentHome, ".session-id"))).toBe(false);
    expect(readFileSync(join(agentHome, ".acp-last-session"), "utf8").trim()).toBe("sess-persist-42");
    await reg.stop(agent);

    // Resume uses the stored session id via session/resume
    const s2 = await reg.start(agent, { resume: true });
    expect(s2.activeSessionId).toBe("sess-persist-42");
    await reg.stop(agent);
  });

  it("Step 5: AcpThreadView upserts tool cards by dedupeKey, renders plain text without HTML injection, and resolves permissions", () => {
    const events: DeckEvent[] = [
      {
        v: 1, id: "e1", seq: 1, ts: "2026-11-22T22:00:00Z", source: { kind: "session", session: "s1" },
        class: "happened", type: "tool.updated", title: "Read file", dedupeKey: "tool-1",
        view: { kind: "tool", name: "Read file", toolKind: "read", status: "in_progress", paths: ["src/a.ts"] },
      },
      {
        v: 1, id: "e2", seq: 2, ts: "2026-11-22T22:00:01Z", source: { kind: "session", session: "s1" },
        class: "happened", type: "tool.updated", title: "Read file", dedupeKey: "tool-1",
        view: { kind: "tool", name: "Read file", toolKind: "read", status: "completed", paths: ["src/a.ts"] },
      },
      {
        v: 1, id: "e3", seq: 3, ts: "2026-11-22T22:00:02Z", source: { kind: "session", session: "s1" },
        class: "happened", type: "message.chunk", title: "Message",
        view: { kind: "text", excerpt: "<script>alert(1)</script> hello" },
      },
      {
        v: 1, id: "p1", seq: 4, ts: "2026-11-22T22:00:03Z", source: { kind: "session", session: "s1" },
        class: "decision", type: "permission.requested", title: "Permission requested",
        view: { kind: "permission", tool: "Write file", options: [{ id: "opt-1", label: "Allow once", optionKind: "allow_once" }] },
      },
    ];

    const derived = deriveAcpCards(events);
    // Two tool.updated events with same dedupeKey collapse into 1 card with latest status
    const toolCards = derived.cards.filter((c) => c.type === "tool.updated");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.view).toMatchObject({ status: "completed" });

    const html = renderToStaticMarkup(
      <AcpThreadView
        agent={agent}
        initialStatus={{ state: "running", queuedCount: 1, contextUsage: { used: 1000, size: 50000 } }}
        initialEvents={events}
        initialLastSessionId={null}
        initialUsageReading={antigravityUsageReading()}
        canWrite={true}
      />,
    );

    // No raw script tag injection (escaped as text)
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Read file (read) - completed");
    expect(html).toContain("Allow once");
    expect(html).toContain("Queued: 1");
    expect(html).toContain("Context: 1000 / 50000 tokens");
  });

  it("Step 5: api.acp route enforces same-origin write guard and refuses stale/cross-agent permission answers", async () => {
    vi.stubEnv("AGENTS_HOME", root);
    vi.stubEnv("MC_ACP_RUNNER", "1");

    // Cross-origin POST must be rejected by requireSameOriginWrite
    const crossOriginReq = makeReq("POST", "http://127.0.0.1:4295/api/acp", { agent, op: "stop" }, "https://evil.example");
    await expect(acpAction({ request: crossOriginReq, params: {}, context: {} } as never)).rejects.toThrow();

    // Stale/inactive answer-permission returns 409
    const staleReq = makeReq("POST", "http://127.0.0.1:4295/api/acp", {
      agent,
      op: "answer-permission",
      eventId: "stale-ev",
      optionId: "opt-1",
    });
    const staleRes = await acpAction({ request: staleReq, params: {}, context: {} } as never);
    expect((staleRes as { init?: ResponseInit }).init?.status).toBe(409);

    // Loader returns optedIn=true and usageReading=unknown
    const loadRes = await acpLoader({
      request: new Request(`http://127.0.0.1:4295/api/acp?agent=${agent}`),
      params: {},
      context: {},
    } as never);
    expect(loadRes).toMatchObject({
      ok: true,
      optedIn: true,
      usageReading: { state: "unknown", source: "antigravity" },
    });
  });
});
