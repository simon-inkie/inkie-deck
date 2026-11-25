import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpThreadView, deriveAcpCards } from "../../app/components/AcpThreadView.js";
import { readAcpUsageReading } from "../../app/lib/acp-usage.server.js";
import * as quotaObserver from "../../app/lib/codex-quota-observer.server.js";
import { initialQuotaState } from "../../app/lib/codex-quota.js";
import { AcpSession } from "../../app/lib/acp-session.server.js";
import type { DeckEvent } from "../../app/lib/deck-event.js";
import { antigravity1Manifest, antigravityUsageReading } from "../../app/lib/runner/acp-manifest.js";
import { AcpRunnerRegistry, acpRunnerRegistry } from "../../app/lib/runner/acp-registry.server.js";
import { action as acpAction, loader as acpLoader } from "../../app/routes/api.acp.js";
import { loader as threadLoader } from "../../app/routes/threads.$agent.js";

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

function sameOriginGet(url: string): Request {
  return new Request(url, { headers: { host: new URL(url).host, "sec-fetch-site": "same-origin" } });
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
    vi.restoreAllMocks();
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

  it("loads replay when both capabilities are advertised and shows each earlier card once", async () => {
    const prompt = "Remember this";
    const reply = "I will";
    const userUpdate = { kind: "update", update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt },
    } };
    const agentUpdate = { kind: "update", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply },
    } };
    const script = {
      sessionId: "sess-replay-43",
      capabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      prompts: [[agentUpdate, { kind: "result", result: { stopReason: "end_turn" } }]],
      onLoad: [userUpdate, agentUpdate],
    };
    const fixture = fileURLToPath(new URL("../fixtures/acp-agent.mjs", import.meta.url));
    const env = { AGENTS_HOME: root, MC_ACP_RUNNER: "1", HOME: root, PATH: process.env.PATH };
    const reg = new AcpRunnerRegistry(env, {
      dataRoot: root,
      manifest: { ...antigravity1Manifest, executableName: process.execPath, args: [fixture, JSON.stringify(script)] },
      execVersion: () => ({ status: 0, stdout: "1.5.14\n", stderr: "" }),
      listWindows: () => [],
    });
    const messages = () => reg.events(agent).flatMap(({ type, view }) =>
      type === "message.chunk" && view.kind === "text" ? [view.excerpt] : []);

    try {
      const session = await reg.start(agent);
      expect(await session.prompt(prompt)).toBe("completed");
      await reg.stop(agent);
      expect(messages()).toContain(reply);

      await reg.start(agent, { resume: true });
      expect(messages()).toEqual([prompt, reply]);
    } finally {
      await reg.stop(agent);
    }
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
      request: sameOriginGet(`http://127.0.0.1:4295/api/acp?agent=${agent}`),
      params: {},
      context: {},
    } as never);
    expect(loadRes).toMatchObject({
      ok: true,
      optedIn: true,
      usageReading: { state: "unknown", source: "antigravity" },
    });
  });

  it("dispatches Codex quota through both loaders and renders its windows", async () => {
    const now = Date.now();
    vi.spyOn(quotaObserver, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    for (const [key, value] of Object.entries({ AGENTS_HOME: root, DATA_ROOT: root,
      INBOX_ROOT: join(root, "inbox"), PROJECTS_ROOT: join(root, "projects"),
      MC_ACP_RUNNER: "1", MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" })) vi.stubEnv(key, value);
    writeFileSync(join(agentHome, ".runtime"), "codex\n");
    writeFileSync(join(root, "codex-quota.json"), JSON.stringify({ ...initialQuotaState(),
      status: "AVAILABLE_CONFIRMED", observedAt: now,
      snapshot: { primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: now / 1000 } } }));
    const api = await acpLoader({ request: sameOriginGet(`http://localhost/api/acp?agent=${agent}`),
      params: {}, context: {} } as Parameters<typeof acpLoader>[0]);
    if (!("usageReading" in api)) throw new Error("Expected successful ACP loader response");
    const thread = await threadLoader({ request: sameOriginGet(`http://localhost/threads/${agent}`),
      params: { agent }, context: {} } as Parameters<typeof threadLoader>[0]);
    for (const reading of [api.usageReading, thread.acp?.usageReading]) {
      expect(reading).toMatchObject({ source: "codex", state: "low", windows: [
        { label: "5-hour", usedPercent: 92, resetsAt: null },
        { label: "7-day", usedPercent: 42, resetsAt: new Date(now).toISOString() },
      ] });
    }
    const html = renderToStaticMarkup(<AcpThreadView agent={agent}
      initialStatus={{ state: "stopped" }} initialEvents={[]} initialLastSessionId={null}
      initialUsageReading={api.usageReading} canWrite={false} />);
    expect(html).toContain('data-testid="acp-quota-reading"');
    expect(html).toContain("Quota (codex): low");
    expect(html).toContain("5-hour: 92% used. Reset: unknown");
    expect(html).toContain(`dateTime="${new Date(now).toISOString()}"`);
    expect(html).not.toContain("null");
  });

  it.each([
    { host: "localhost", site: "same-origin", trusted: true },
    { host: "localhost", site: "cross-site", trusted: false },
    { host: "unlisted.example", site: "same-origin", trusted: false },
  ])("returns ACP transcript data only for trusted requests ($host, $site)", async ({ host, site, trusted }) => {
    vi.stubEnv("AGENTS_HOME", root);
    vi.stubEnv("INBOX_ROOT", join(root, "inbox"));
    vi.stubEnv("PROJECTS_ROOT", join(root, "projects"));
    vi.stubEnv("MC_ACP_RUNNER", "1");
    vi.stubEnv("MC_ALLOWED_HOSTS", undefined);
    vi.stubEnv("HOST", undefined);

    const lastSessionId = "saved-acp-checkpoint";
    writeFileSync(join(agentHome, ".acp-last-session"), lastSessionId + "\n");
    const events: DeckEvent[] = [{
      v: 1,
      id: "transcript-event",
      seq: 1,
      ts: "2026-11-23T12:00:00Z",
      source: { kind: "agent", session: lastSessionId },
      class: "happened",
      type: "message.chunk",
      title: "Agent reply",
      view: { kind: "text", excerpt: "Private transcript text" },
    }];
    const status = { state: "stopped" as const, code: 0, exitedAt: 1, events };
    vi.spyOn(acpRunnerRegistry, "status").mockReturnValue(status);
    vi.spyOn(acpRunnerRegistry, "events").mockReturnValue(events);
    vi.spyOn(acpRunnerRegistry, "canResume").mockReturnValue(true);

    const headers = { host, "sec-fetch-site": site };
    const api = await acpLoader({
      request: new Request(`http://${host}/api/acp?agent=${agent}`, { headers }),
      params: {},
      context: {},
    } as Parameters<typeof acpLoader>[0]);
    const thread = await threadLoader({
      request: new Request(`http://${host}/threads/${agent}`, { headers }),
      params: { agent },
      context: {},
    } as Parameters<typeof threadLoader>[0]);

    const expected = trusted
      ? { status, events, lastSessionId, canResume: true }
      : { status: { state: "stopped", code: null, exitedAt: 0 }, events: [], lastSessionId: null, canResume: false };
    expect(api).toMatchObject(expected);
    expect(thread.acp).toMatchObject({ ...expected, canWrite: trusted });
    if (!trusted) {
      for (const payload of [api, thread]) {
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain(lastSessionId);
        expect(serialized).not.toContain("Private transcript text");
      }
    }
  });

  it.each([
    { host: "localhost", site: "cross-site", provider: "plus" as const },
    { host: "unlisted.example", site: "same-origin", provider: "azure" as const },
  ])("R1-2: untrusted GETs under .runtime=codex do not leak Codex quota or trigger observer ($host, $site, $provider)", async ({ host, site, provider }) => {
    const now = Date.now();
    const ensure = vi.spyOn(quotaObserver, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    for (const [key, value] of Object.entries({
      AGENTS_HOME: root,
      DATA_ROOT: root,
      INBOX_ROOT: join(root, "inbox"),
      PROJECTS_ROOT: join(root, "projects"),
      MC_ACP_RUNNER: "1",
      MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1",
    })) vi.stubEnv(key, value);
    vi.stubEnv("MC_ALLOWED_HOSTS", undefined);
    vi.stubEnv("HOST", undefined);

    writeFileSync(join(agentHome, ".runtime"), "codex\n");
    if (provider === "azure") {
      mkdirSync(join(root, "provider-switch", "current"), { recursive: true });
      writeFileSync(join(root, "provider-switch", "current", `${agent}.json`), JSON.stringify({ agent, provider: "azure" }));
    }
    writeFileSync(join(root, "codex-quota.json"), JSON.stringify({
      ...initialQuotaState(),
      status: "AVAILABLE_CONFIRMED",
      observedAt: now,
      snapshot: {
        primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: now / 1000 },
      },
    }));

    const headers = { host, "sec-fetch-site": site };
    const api = await acpLoader({
      request: new Request(`http://${host}/api/acp?agent=${agent}`, { headers }),
      params: {},
      context: {},
    } as Parameters<typeof acpLoader>[0]);
    const thread = await threadLoader({
      request: new Request(`http://${host}/threads/${agent}`, { headers }),
      params: { agent },
      context: {},
    } as Parameters<typeof threadLoader>[0]);

    expect(ensure).not.toHaveBeenCalled();
    if (!("usageReading" in api)) throw new Error("Expected successful ACP loader response");
    expect(api.usageReading).toMatchObject({ state: "unknown", source: "unknown" });
    expect(api.usageReading.windows).toBeUndefined();
    expect(thread.acp?.usageReading).toMatchObject({ state: "unknown", source: "unknown" });
    expect(thread.acp?.usageReading.windows).toBeUndefined();
    for (const payload of [api, thread]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("codex-azure");
      expect(serialized).not.toContain("5-hour");
      expect(serialized).not.toContain('"codex"');
    }
  });

  it("R1-2: MC_ACP_RUNNER=0 under .runtime=codex does not leak Codex quota or trigger observer", async () => {
    const now = Date.now();
    const ensure = vi.spyOn(quotaObserver, "ensureCodexQuotaObserver").mockReturnValue(undefined);
    for (const [key, value] of Object.entries({
      AGENTS_HOME: root,
      DATA_ROOT: root,
      INBOX_ROOT: join(root, "inbox"),
      PROJECTS_ROOT: join(root, "projects"),
      MC_ACP_RUNNER: "0",
      MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1",
    })) vi.stubEnv(key, value);

    writeFileSync(join(agentHome, ".runtime"), "codex\n");
    writeFileSync(join(root, "codex-quota.json"), JSON.stringify({
      ...initialQuotaState(),
      status: "AVAILABLE_CONFIRMED",
      observedAt: now,
      snapshot: {
        primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: null },
      },
    }));

    for (const provider of ["plus", "azure"] as const) {
      if (provider === "azure") {
        mkdirSync(join(root, "provider-switch", "current"), { recursive: true });
        writeFileSync(join(root, "provider-switch", "current", `${agent}.json`), JSON.stringify({ agent, provider: "azure" }));
      }
      const api = await acpLoader({
        request: sameOriginGet(`http://localhost/api/acp?agent=${agent}`),
        params: {},
        context: {},
      } as Parameters<typeof acpLoader>[0]);
      const thread = await threadLoader({
        request: sameOriginGet(`http://localhost/threads/${agent}`),
        params: { agent },
        context: {},
      } as Parameters<typeof threadLoader>[0]);
      const directReading = readAcpUsageReading(process.env, agent, now);

      expect(ensure).not.toHaveBeenCalled();
      if (!("usageReading" in api)) throw new Error("Expected successful ACP loader response");
      expect(api.optedIn).toBe(false);
      expect(api.usageReading).toMatchObject({ state: "unknown", source: "unknown" });
      expect(api.usageReading.windows).toBeUndefined();
      expect(thread.acp).toBeUndefined();
      expect(directReading).toMatchObject({ state: "unknown", source: "unknown" });
      expect(directReading.windows).toBeUndefined();
      const serialized = JSON.stringify({ api, thread, directReading });
      expect(serialized).not.toContain("codex-azure");
      expect(serialized).not.toContain("5-hour");
      expect(serialized).not.toContain('"codex"');
    }
  });
});
