import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadNodePty } from "~/lib/runner/pty-runner.server";
import { runnerRegistry, RunnerRegistry } from "~/lib/runner/registry.server";
import { createRunnerScreen } from "~/lib/runner/screen.server";
import { action as operate } from "../../app/routes/api.runner";
import { action as send } from "../../app/routes/api.tmux-send";
import { action as reply, loader } from "../../app/routes/threads.$agent";
import { fixtureCommand, fixtureScreen, type FixtureSpec } from "./fixture-command";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: vi.fn(),
}));

const agent = "fixture-agent";
const other = "fixture-tmux";
const headers = { host: "localhost", origin: "http://localhost" };
let root: string;
let agentHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deck-pty-routes-"));
  const homes = join(root, "agents");
  const inbox = join(root, "inbox");
  agentHome = join(homes, agent);
  mkdirSync(agentHome, { recursive: true });
  mkdirSync(join(homes, other));
  mkdirSync(join(inbox, agent, "inbox"), { recursive: true });
  writeFileSync(join(agentHome, ".runner"), "pty\n");
  writeFileSync(join(agentHome, ".inbox-root"), inbox);
  vi.stubEnv("AGENTS_HOME", homes);
  vi.stubEnv("INBOX_ROOT", inbox);
  vi.stubEnv("MC_PTY_RUNNER", "1");
  vi.stubEnv("MC_TMUX_ENABLED", "1");
  vi.stubEnv("MC_USER", "operator");
  vi.mocked(execFileSync).mockReset().mockReturnValue("");
  stubLaunch("registry", fixtureScreen);
});

afterEach(async () => {
  try {
    await runnerRegistry.stop(agent);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { force: true, recursive: true });
  }
});

function stubLaunch(scenario: FixtureSpec["scenario"], createScreen: typeof createRunnerScreen) {
  const launchSpec = vi.fn(({ cwd }: { cwd: string }) => fixtureCommand(cwd, { scenario, cols: 132 }));
  const registry = new RunnerRegistry(process.env, { launchSpec, createScreen });
  vi.spyOn(runnerRegistry, "start").mockImplementation((target) => registry.start(target));
  return launchSpec;
}

function runOp(op: string, target = agent, origin = headers.origin) {
  const request = new Request("http://localhost/api/runner", {
    method: "POST", headers: { ...headers, origin, "content-type": "application/json" },
    body: JSON.stringify({ agent: target, op }),
  });
  return operate({ request, context: {} } as Parameters<typeof operate>[0]);
}

function runSend(fields: { text: string } | { key: string }, target = agent) {
  const request = new Request("http://localhost/api/tmux-send", {
    method: "POST", headers, body: new URLSearchParams({ window: target, ...fields }),
  });
  return send({ request, context: {} } as Parameters<typeof send>[0]);
}

function load(target = agent, origin = headers.origin) {
  const request = new Request(`http://localhost/threads/${target}?view=tmux`, { headers: { ...headers, origin } });
  return loader({ request, params: { agent: target }, context: {} } as Parameters<typeof loader>[0]);
}

function threadPost(target: string, fields: Record<string, string>) {
  const request = new Request(`http://localhost/threads/${target}`, {
    method: "POST", headers, body: new URLSearchParams(fields),
  });
  return reply({ request, params: { agent: target }, context: {} } as Parameters<typeof reply>[0]);
}

it("rejects untrusted, invalid and non-opted-in control requests before launch", async () => {
  await expect(runOp("start", agent, "http://example.invalid")).rejects.toMatchObject({ status: 403 });
  await expect(runOp("reset")).resolves.toMatchObject({ init: { status: 400 } });
  for (const op of ["start", "stop", "cancel"]) {
    await expect(runOp(op, other)).resolves.toMatchObject({ init: { status: 403 } });
  }
  vi.stubEnv("MC_TMUX_ENABLED", "0");
  await expect(runOp("start")).resolves.toMatchObject({ init: { status: 403 } });
  expect(runnerRegistry.start).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
});

it.runIf(process.platform === "linux")("refuses a live tmux window before a spinner or process can start", async () => {
  const launchSpec = stubLaunch("registry", fixtureScreen);
  vi.mocked(execFileSync).mockReturnValue(`${agent}\n`);
  await expect(runOp("start")).resolves.toMatchObject({
    init: { status: 409 }, data: { error: expect.stringContaining("Close the agent's tmux window") },
  });
  expect(launchSpec).not.toHaveBeenCalled();
  expect(existsSync(join(agentHome, ".runner.lock"))).toBe(false);
});

it("does not send or capture tmux for a draining target, but leaves other agents on tmux", async () => {
  vi.mocked(execFileSync).mockImplementation((_file, args) => args?.[0] === "list-windows"
    ? `${agent}\n${other}\n` : "TMUX PANE");
  await expect(runSend({ text: "Do not send" })).resolves.toMatchObject({ ok: false });
  await expect(runSend({ key: "Enter" })).resolves.toMatchObject({ ok: false });
  expect((await load()).tmux).toMatchObject({ pane: undefined, runner: { state: "not-started" } });
  expect(execFileSync).not.toHaveBeenCalled();
  expect((await load(other)).tmux).toEqual({ pane: "TMUX PANE" });
  await expect(runSend({ key: "Enter" }, other)).resolves.toEqual({ ok: true });
  expect(execFileSync).toHaveBeenCalledWith("tmux", ["send-keys", "-t", expect.stringContaining(`:=${other}`), "Enter"], expect.anything());
});

it("preserves inbox writes and targets PTY pushes and wakes at the recipient, not the open thread", async () => {
  const submit = vi.spyOn(runnerRegistry, "submit");
  await expect(threadPost(other, { intent: "compose", targetAgent: agent, body: "Read the brief", dictated: "1" }))
    .resolves.toMatchObject({ ok: true });
  expect(submit).toHaveBeenCalledExactlyOnceWith(agent, "[inbox from operator] [DICTATED] Read the brief  [reply via inbox: inbox reply operator]");
  expect(readFileSync(join(process.env.INBOX_ROOT!, agent, "inbox", "operator.md"), "utf8")).toContain("Read the brief");
  writeFileSync(join(process.env.INBOX_ROOT!, agent, "inbox", "operator.md"), [
    `## 2026-06-09T10:00:00Z - from: ${agent} - status: sent - subject: A decision`,
    "decision-id: fixture-decision", "options:", "  - key: A", "    label: Hold", "    detail: Hold.",
    "", "Please decide.", "", "---", "",
  ].join("\n"));
  await expect(threadPost(agent, { intent: "answer", decisionId: "fixture-decision", answerKey: "A" }))
    .resolves.toMatchObject({ ok: true });
  expect(submit).toHaveBeenLastCalledWith(agent, "[inbox from operator] new message in Inkie Deck, check your inbox  [reply via inbox: inbox reply operator]");
  expect(execFileSync).not.toHaveBeenCalled();
});

let ptyAvailable = false;
let screenAvailable = false;
try { ptyAvailable = process.platform === "linux" && Boolean(loadNodePty()); } catch {}
try { screenAvailable = Boolean(createRequire(import.meta.url).resolve("@xterm/headless")); } catch {}

it.runIf(ptyAvailable)("refuses a second launch and refuses sends when composer style is unavailable", async () => {
  await expect(runOp("start")).resolves.toEqual({ ok: true });
  const lock = join(agentHome, ".runner.lock");
  const owner = readFileSync(lock, "utf8");
  await expect(runOp("start")).resolves.toMatchObject({ init: { status: 409 } });
  expect(readFileSync(lock, "utf8")).toBe(owner);
  expect((await load()).tmux).toMatchObject({ pane: expect.stringContaining("FIXTURE READY"), runner: { state: "running" } });
  expect((await load(agent, "http://example.invalid")).tmux).toMatchObject({ pane: undefined, runner: undefined });
  await expect(runSend({ text: "exit23" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not proven safe") });
  expect(runnerRegistry.status(agent)).toEqual({ state: "running" });
  rmSync(join(agentHome, ".runner"));
  vi.mocked(execFileSync).mockClear();
  await expect(runSend({ key: "Enter" })).resolves.toMatchObject({ ok: false });
  expect(execFileSync).not.toHaveBeenCalled();
  writeFileSync(join(agentHome, ".runner"), "pty\n");
  await expect(runOp("stop")).resolves.toEqual({ ok: true });
  expect((await load()).tmux).toMatchObject({ pane: undefined, runner: { state: "stopped" } });
  expect(existsSync(lock)).toBe(false);
  await expect(runOp("cancel")).resolves.toMatchObject({ init: { status: 409 } });
});

it.runIf(ptyAvailable)("does not send a deferred Enter into a replacement session", async () => {
  const composer = vi.fn().mockReturnValue({ composer: "clean", activity: "idle" });
  stubLaunch("registry", () => ({ ...fixtureScreen(), composer }));
  await expect(runOp("start")).resolves.toEqual({ ok: true });
  const result = runSend({ text: "First session only" });
  await vi.waitFor(() => expect(composer).toHaveBeenCalled());
  await expect(runOp("stop")).resolves.toEqual({ ok: true });
  await expect(runOp("start")).resolves.toEqual({ ok: true });
  await expect(result).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Enter was not sent") });
  expect(runnerRegistry.capture(agent)).toContain("FIXTURE READY");
  expect(composer).toHaveBeenCalledTimes(1);
});

it.runIf(ptyAvailable)("sends a verified literal paste once, then reports uncertainty without retrying Enter blindly", async () => {
  const text = "First line\nSecond line";
  const composer = vi.fn()
    .mockReturnValueOnce({ composer: "clean", activity: "idle" })
    .mockReturnValueOnce({ composer: "staged", activity: "idle", stagedText: text })
    .mockReturnValue({ composer: "unknown", activity: "idle" });
  stubLaunch("registry", () => ({ ...fixtureScreen(), composer }));
  await expect(runOp("start")).resolves.toEqual({ ok: true });
  const result = runSend({ text });
  await vi.waitFor(() => expect(composer).toHaveBeenCalled());
  await expect(runSend({ key: "Enter" })).resolves.toMatchObject({ ok: false });
  await expect(result).resolves.toEqual({ ok: false, unverified: true, error: "Sent, could not confirm delivery." });
  expect(runnerRegistry.capture(agent)?.replace(/\r\n/g, "\n")).toContain(`INPUT ${text}`);
});

describe.runIf(ptyAvailable && screenAvailable)("headless screen with the PTY stub", () => {
  async function start(scenario: FixtureSpec["scenario"]) {
    stubLaunch(scenario, createRunnerScreen);
    await expect(runOp("start")).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(runnerRegistry.capture(agent)).toContain("Try a task"));
  }

  it("renders dim ghost output and submits exactly one literal multiline paste", async () => {
    await start("screen");
    const text = "First line\nSecond line";
    const result = runSend({ text });
    await vi.waitFor(() => expect(runnerRegistry.capture(agent)).toContain("Second line"));
    await expect(runSend({ key: "Enter" })).resolves.toMatchObject({ ok: false });
    await expect(result).resolves.toEqual({ ok: true });
    expect((await load()).tmux?.pane).toContain(`INPUT ${JSON.stringify(text)}`);
    await expect(runOp("cancel")).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(runnerRegistry.capture(agent)).toContain("INTERRUPTED"));
  });

  it("refuses automatic input on a confirmation dialog and allows an intentional named key", async () => {
    await start("screen-dialog");
    await expect(runSend({ text: "Must not arrive" })).resolves.toMatchObject({ ok: false });
    expect(runnerRegistry.capture(agent)).toContain("CONFIRM?");
    expect(runnerRegistry.capture(agent)).not.toContain("UNEXPECTED");
    await expect(runSend({ key: "Escape" })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(runnerRegistry.capture(agent)).toContain("DECLINED"));
  });

  it("leaves an opaque paste staged without pressing Enter", async () => {
    await start("screen-placeholder");
    await expect(runSend({ text: "Cannot verify hidden text" })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining("Enter was not sent"),
    });
    expect(runnerRegistry.capture(agent)).toContain("[Pasted text #1]");
    expect(runnerRegistry.capture(agent)).not.toContain("INPUT");
  });

  it("reports an unconfirmed send without pressing Enter on the subsequent dialog", async () => {
    await start("screen-unverified");
    await expect(runSend({ text: "Check first" })).resolves.toEqual({
      ok: false, unverified: true, error: "Sent, could not confirm delivery.",
    });
    expect(runnerRegistry.capture(agent)).toContain('INPUT "Check first"');
    expect(runnerRegistry.capture(agent)).toContain("CONFIRM?");
  });
});
