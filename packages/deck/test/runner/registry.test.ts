import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadNodePty } from "../../app/lib/runner/pty-runner.server.js";
import { isPtyOptedIn, RunnerRegistry } from "../../app/lib/runner/registry.server.js";
import { listTmuxWindows } from "../../app/lib/tmux.server.js";
import { fixtureCommand, fixtureScreen } from "./fixture-command.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: vi.fn(),
}));

const agent = "fixture-agent";
const other = "second-fixture";
let root: string;
let home: string;
let lock: string;
let inbox: string;
let env: NodeJS.ProcessEnv;

function addAgent(name: string) {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".runner"), "pty\n");
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { INBOX_ROOT: inbox } }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deck-runner-"));
  home = join(root, agent);
  lock = join(home, ".runner.lock");
  inbox = join(root, "inbox");
  env = { AGENTS_HOME: root, MC_PTY_RUNNER: "1", HOME: root };
  addAgent(agent);
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockReturnValue("");
});

afterEach(async () => {
  try {
    const registry = new RunnerRegistry(env);
    await registry.stop(agent);
    await registry.stop(other);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("requires both opt-ins and only accepts Claude or an absent runtime", async () => {
  const marker = join(home, ".runner");
  const runtime = join(home, ".runtime");
  for (const flag of [undefined, "0", "true", "1 ", "1"]) {
    for (const runnerValue of [undefined, "tmux", "PTY", "pty\nextra", "pty\n"]) {
      if (runnerValue === undefined) rmSync(marker, { force: true });
      else writeFileSync(marker, runnerValue);
      for (const value of [undefined, "claude\n", "codex", "agy", "", "unknown"]) {
        if (value === undefined) rmSync(runtime, { force: true });
        else writeFileSync(runtime, value);
        expect(isPtyOptedIn({ ...env, MC_PTY_RUNNER: flag }, agent)).toBe(
          flag === "1" && runnerValue === "pty\n" && (value === undefined || value === "claude\n"),
        );
      }
    }
  }
  const launchSpec = vi.fn(fixtureCommand);
  await expect(new RunnerRegistry(env, { launchSpec: ({ cwd }) => launchSpec(cwd, {}) }).start(agent))
    .rejects.toMatchObject({ reason: "not-opted-in" });
  expect(launchSpec).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(false);
});

it("distinguishes an absent tmux session from an unverified one", () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw { status: 1, stderr: "can't find session: fixture\n" }; });
  expect(listTmuxWindows(env, true)).toEqual([]);
  vi.mocked(execFileSync).mockImplementation(() => { throw { code: "ETIMEDOUT" }; });
  expect(() => listTmuxWindows(env, true)).toThrow("Could not verify tmux window ownership.");
  expect(listTmuxWindows(env)).toEqual([]);
});

let ptyAvailable = false;
if (process.platform === "linux") {
  try {
    ptyAvailable = Boolean(loadNodePty());
  } catch {}
}

function stubRegistry(options: ConstructorParameters<typeof RunnerRegistry>[1] = {}) {
  return new RunnerRegistry(env, {
    launchSpec: ({ cwd, env: childEnv }) => ({ ...fixtureCommand(cwd, { scenario: "registry" }), env: childEnv }),
    createScreen: fixtureScreen,
    ...options,
  });
}

function processStat(pid: number): string[] {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if (!(error instanceof Error) || !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return [];
  }
}

function running(pid: number): boolean {
  const [state] = processStat(pid);
  return state !== undefined && state !== "Z" && state !== "X";
}

describe.runIf(process.platform === "linux")("registry ownership", () => {
  it("refuses a live tmux window, an unknown probe and an exclusive lock", async () => {
    const registry = stubRegistry();
    vi.mocked(execFileSync).mockReturnValue(`${agent}\n`);
    await expect(registry.start(agent)).rejects.toMatchObject({ reason: "tmux-active" });
    expect(existsSync(lock)).toBe(false);
    vi.mocked(execFileSync).mockImplementation(() => { throw { code: "ETIMEDOUT" }; });
    await expect(registry.start(agent)).rejects.toMatchObject({ reason: "tmux-unknown" });
    expect(existsSync(lock)).toBe(false);
    vi.mocked(execFileSync).mockReturnValue("");
    writeFileSync(lock, "held\n");
    await expect(registry.start(agent)).rejects.toMatchObject({ reason: "locked" });
    expect(readFileSync(lock, "utf8")).toBe("held\n");
  });

  it("leaves a mismatched group untouched and reclaims only after the verified group stops", async () => {
    const finished = spawnSync(process.execPath, ["-e", ""], { env: {} });
    expect(finished.status).toBe(0);
    const stub = spawn(process.execPath, [fixtureCommand(home, {}).args[0]!, "detached"], {
      cwd: home, detached: true, env: {}, stdio: "ignore",
    });
    const exited = once(stub, "exit");
    try {
      const pid = stub.pid!;
      await vi.waitFor(() => expect(processStat(pid)[3]).toBe(String(pid)));
      const record = {
        deckPid: finished.pid, deckBirth: "0", childPid: pid, childBirth: "0",
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        sessionId: "01234567-89ab-4cde-8fab-0123456789ab", startedAt: Date.now(),
      };
      const registry = stubRegistry();
      writeFileSync(lock, JSON.stringify(record));
      await registry.recover();
      expect(registry.status(agent)).toMatchObject({ state: "locked" });
      expect(running(pid)).toBe(true);
      expect(existsSync(lock)).toBe(true);
      addAgent(other);
      await expect(registry.start(other)).rejects.toMatchObject({ reason: "locked" });

      writeFileSync(lock, JSON.stringify({ ...record, childBirth: processStat(pid)[19] }));
      await registry.recover();
      expect(await exited).toEqual([null, "SIGKILL"]);
      expect(running(pid)).toBe(false);
      expect(existsSync(lock)).toBe(false);
      expect(registry.status(agent)).toMatchObject({ state: "stopped", code: null });
    } finally {
      stub.kill("SIGKILL");
      await exited;
    }
  });
});

describe.runIf(ptyAvailable)("with the PTY stub", () => {
  it("starts one fresh session with an allowlisted environment and keeps the old pin", async () => {
    addAgent(other);
    const pin = join(home, ".session-id");
    writeFileSync(pin, "saved-tmux-session\n");
    writeFileSync(join(home, ".inbox-root"), join(root, "old-inbox") + "\n");
    Object.assign(env, {
      PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "fixture-user",
      CLAUDE_CONFIG_DIR: join(root, "config"), INBOX_ROOT: join(root, "wrong-inbox"),
      MC_TOKEN: "fixture-secret", ANTHROPIC_API_KEY: "fixture-secret", PWD: join(root, "wrong-cwd"),
    });
    const launchSpec = vi.fn((spec: ReturnType<typeof fixtureCommand>) => ({
      ...fixtureCommand(spec.cwd, {}), env: spec.env,
    }));
    const registry = stubRegistry({ launchSpec });
    const start = registry.start(agent);
    await expect(stubRegistry().start(other)).rejects.toMatchObject({ reason: "busy" });
    await start;
    vi.resetModules();
    const reloaded = await import("../../app/lib/runner/registry.server.js");
    await expect(new reloaded.RunnerRegistry(env, { launchSpec, createScreen: fixtureScreen }).start(agent)).rejects.toMatchObject({ reason: "busy" });
    const first = JSON.parse(readFileSync(lock, "utf8"));
    expect(first).toMatchObject({ deckPid: process.pid, childPid: expect.any(Number), startedAt: expect.any(Number) });
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(first.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(launchSpec).toHaveBeenCalledWith({
      command: "claude", args: ["--session-id", first.sessionId, "-n", agent], cwd: home,
      env: { HOME: root, PATH: env.PATH, TERM: "xterm", LANG: "C", USER: env.USER,
        CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, MC_PTY_RUNNER: "1", AGENTS_HOME: root, INBOX_ROOT: inbox },
    });
    await stubRegistry().recover();
    expect(running(first.childPid)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    await registry.stop(agent);
    expect(existsSync(lock)).toBe(false);
    await registry.start(agent);
    expect(JSON.parse(readFileSync(lock, "utf8")).sessionId).not.toBe(first.sessionId);
    expect(readFileSync(pin, "utf8")).toBe("saved-tmux-session\n");
  });

  it("persists replies from a PTY child without probing the marked recipient's tmux window", async () => {
    addAgent(other);
    writeFileSync(join(root, other, ".runtime"), "claude\n");
    mkdirSync(join(inbox, other, "inbox"), { recursive: true });
    mkdirSync(join(inbox, agent, "inbox"), { recursive: true });
    const thread = join(inbox, other, "inbox", `${agent}.md`);
    symlinkSync(thread, join(inbox, agent, "inbox", `${other}.md`));

    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> tmux.log\n[ "$1" = list-windows ] && printf '%s\\n' '${other}'\n`,
      { mode: 0o755 });
    env = { ...env, AGENTS_HOME: undefined, AGENTS_ROOT: root, PATH: `${bin}:/usr/bin:/bin` };
    const inboxCli = fileURLToPath(new URL("../../../base/bin/inbox", import.meta.url));
    const message = "Keep the full message.";
    const registry = stubRegistry({
      listWindows: () => [other],
      launchSpec: (spec) => ({
        ...spec, command: "/bin/bash",
        args: ["-c", 'printf "ready\\n"; read -r && AGENT_NAME="$1" exec "$2" reply "$3" --subject cutover --body "$4" > reply.log',
          "inbox-fixture", agent, inboxCli, other, message],
      }),
    });

    await registry.start(agent);
    expect(await registry.key(agent, "Enter")).toEqual({ status: "written" });
    await vi.waitFor(() => expect(registry.status(agent)).toMatchObject({ state: "stopped", code: 0 }));
    expect(readFileSync(thread, "utf8")).toContain(message);
    expect(readFileSync(join(home, "reply.log"), "utf8")).toContain("push: skip:pty-runner (persisted, not pushed)");
    expect(existsSync(join(home, "tmux.log"))).toBe(false);
  });

  it("makes an unanswered write quiet without stopping, then records exit 23 and refuses input", async () => {
    let clock = Date.now();
    const registry = stubRegistry({ now: () => clock });
    await registry.start(agent);
    const { childPid } = JSON.parse(readFileSync(lock, "utf8"));
    clock += 10 * 60 * 1000;
    expect(registry.status(agent)).toEqual({ state: "running" });
    expect(await registry.write(agent, "hang")).toEqual({ status: "written" });
    expect(await registry.key(agent, "Enter")).toEqual({ status: "written" });
    clock += 10 * 60 * 1000 - 1;
    expect(registry.status(agent)).toEqual({ state: "running" });
    clock++;
    expect(registry.status(agent)).toEqual({ state: "quiet" });
    expect(running(childPid)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(await registry.write(agent, "answer")).toEqual({ status: "written" });
    expect(await registry.key(agent, "Enter")).toEqual({ status: "written" });
    await vi.waitFor(() => expect(registry.status(agent)).toEqual({ state: "running" }));
    expect(await registry.write(agent, "exit23")).toEqual({ status: "written" });
    expect(await registry.key(agent, "Enter")).toEqual({ status: "written" });
    await vi.waitFor(() => expect(registry.status(agent)).toEqual({ state: "stopped", code: 23, exitedAt: clock }));
    expect(existsSync(lock)).toBe(false);
    expect(await registry.write(agent, "must not reach a shell")).toEqual({ status: "refused", reason: "not-running" });
    expect(await registry.key(agent, "Enter")).toEqual({ status: "refused", reason: "not-running" });
  });

  it.each(["SIGTERM", "SIGINT"] as const)("stops Deck and its stub group on %s without binding a port", async (signal) => {
    const fixtureDeck = fileURLToPath(new URL("./fixture-deck.mjs", import.meta.url));
    const deck = spawn(process.execPath, ["--import", "tsx", "server/production.mjs", fixtureDeck], {
      env: { ...env, HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    deck.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const exited = once(deck, "exit");
    let fixture: { childPid: number; descendant: number } | undefined;
    deck.on("message", (message) => { fixture = message as typeof fixture; });
    try {
      await vi.waitFor(() => expect(fixture, stderr).toEqual({ childPid: expect.any(Number), descendant: expect.any(Number) }), { timeout: 3000 });
      expect(running(fixture!.childPid)).toBe(true);
      expect(running(fixture!.descendant)).toBe(true);
      deck.kill(signal);
      await expect(exited).resolves.toEqual([0, null]);
      expect(existsSync(lock)).toBe(false);
      expect(running(fixture!.childPid)).toBe(false);
      expect(running(fixture!.descendant)).toBe(false);
    } finally {
      deck.kill("SIGTERM");
      await exited;
    }
  }, 10_000);
});
