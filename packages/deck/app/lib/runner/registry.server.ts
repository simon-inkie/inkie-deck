import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAgentsRoot } from "../agent-model.server.js";
import { ptyRunnerEnabled } from "../instance.server.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import {
  listTmuxWindows, SEND_KEYS_ENTER_DELAY_MS, SEND_KEYS_VERIFY_DELAYS_MS, type PaneKey,
} from "../tmux.server.js";
import { submitPaneText, type SendKeysResult } from "../tmux-submit.js";
import { claimRunnerLock, hasCode, recoverRunnerLock } from "./lock.server.js";
import { PtyRunner } from "./pty-runner.server.js";
import { LaunchFailure, type SessionSpec, type WriteResult } from "./runner.js";
import { createRunnerScreen, type RunnerScreen } from "./screen.server.js";

const quietAfterMs = 10 * 60 * 1000;
const lockName = ".runner.lock";
const allowedEnv = ["HOME", "PATH", "TERM", "LANG", "USER", "CLAUDE_CONFIG_DIR", "MC_PTY_RUNNER"] as const;

type ActiveSession = {
  state: "starting" | "running" | "stopping";
  runner: PtyRunner;
  screen: RunnerScreen;
  settled: Promise<void>;
  outputVersion: number;
  unansweredSince?: number;
  submission?: { cancelled: boolean };
};
type InactiveSession =
  | { state: "stopped"; code: number | null; exitedAt: number }
  | { state: "locked"; reason: string }
  | { state: "unavailable"; reason: string };
export type SessionStatus = { state: ActiveSession["state"] | "quiet" } | InactiveSession;

const registryKey = Symbol.for("inkie-deck.runner.registry");
const globals = globalThis as typeof globalThis & {
  [registryKey]?: { sessions: Map<string, ActiveSession | InactiveSession>; closing: boolean; recoveryFailed: boolean };
};
const shared = globals[registryKey] ??= { sessions: new Map(), closing: false, recoveryFailed: false };

export class StartRefusal extends Error {
  constructor(readonly reason: "not-opted-in" | "busy" | "tmux-active" | "tmux-unknown" | "locked" | "shutting-down") {
    super(reason);
    this.name = "StartRefusal";
  }
}

function agentsRoot(env: NodeJS.ProcessEnv): string {
  return resolveAgentsRoot({ AGENTS_ROOT: env.AGENTS_HOME?.trim() || env.AGENTS_ROOT });
}

function agentHome(env: NodeJS.ProcessEnv, agent: string): string | undefined {
  if (!AGENT_NAME_RE.test(agent)) return undefined;
  try {
    const home = join(realpathSync(agentsRoot(env)), agent);
    return lstatSync(home).isDirectory() ? home : undefined;
  } catch {
    return undefined;
  }
}

function readAgentFile(file: string): string | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile()) throw new Error("Invalid agent file.");
  return readFileSync(file, "utf8").trim();
}

function optedIn(home: string): boolean {
  try {
    if (readAgentFile(join(home, ".runner")) !== "pty") return false;
    const runtime = readAgentFile(join(home, ".runtime"));
    return runtime === undefined || runtime === "claude";
  } catch {
    return false;
  }
}

export function isPtyOptedIn(env: NodeJS.ProcessEnv, agent: string): boolean {
  if (!ptyRunnerEnabled(env)) return false;
  const home = agentHome(env, agent);
  return home !== undefined && optedIn(home);
}

function launchEnvironment(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const childEnv: Record<string, string> = { AGENTS_HOME: dirname(home) };
  for (const name of allowedEnv) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  try {
    const settings = JSON.parse(readAgentFile(join(home, ".claude", "settings.json")) ?? "{}");
    const inboxRoot: unknown = settings?.env?.INBOX_ROOT ?? readAgentFile(join(home, ".inbox-root"));
    if (typeof inboxRoot === "string" && isAbsolute(inboxRoot) && !/[\r\n\0]/.test(inboxRoot)) {
      childEnv.INBOX_ROOT = inboxRoot;
      return childEnv;
    }
  } catch (error) {
    throw new LaunchFailure("start-failed", "Could not read the agent's INBOX_ROOT.", error);
  }
  throw new LaunchFailure("start-failed", "The agent needs an absolute INBOX_ROOT.");
}

interface RegistryOptions {
  launchSpec?: (spec: SessionSpec) => SessionSpec;
  listWindows?: typeof listTmuxWindows;
  createScreen?: typeof createRunnerScreen;
  now?: () => number;
}

export class RunnerRegistry {
  private readonly now: () => number;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private session(agent: string) {
    const home = agentHome(this.env, agent);
    return home === undefined ? undefined : shared.sessions.get(home);
  }

  handlesTerminal(agent: string): boolean {
    for (const [path, session] of shared.sessions) {
      if ("runner" in session && basename(path) === agent) return true;
    }
    const home = agentHome(this.env, agent);
    if (!home) return false;
    if (ptyRunnerEnabled(this.env) && optedIn(home)) return true;
    const session = shared.sessions.get(home);
    if (session?.state === "locked") return true;
    try {
      return lstatSync(join(home, lockName), { throwIfNoEntry: false }) !== undefined;
    } catch {
      return true;
    }
  }

  capture(agent: string): string | undefined {
    if (!isPtyOptedIn(this.env, agent)) return undefined;
    const session = this.session(agent);
    return session && "runner" in session ? session.screen.capture() : undefined;
  }

  status(agent: string): SessionStatus | undefined {
    const session = this.session(agent);
    if (!session || !("runner" in session)) return session;
    const quiet = session.state === "running" && session.unansweredSince !== undefined &&
      this.now() - session.unansweredSince >= quietAfterMs;
    return { state: quiet ? "quiet" : session.state };
  }

  async start(agent: string): Promise<void> {
    if (shared.closing) throw new StartRefusal("shutting-down");
    const home = ptyRunnerEnabled(this.env) ? agentHome(this.env, agent) : undefined;
    if (!home || !optedIn(home)) throw new StartRefusal("not-opted-in");
    if (shared.recoveryFailed) throw new StartRefusal("locked");
    for (const session of shared.sessions.values()) {
      if ("runner" in session) throw new StartRefusal("busy");
      if (session.state === "locked") throw new StartRefusal("locked");
    }
    if (process.platform !== "linux") {
      const reason = "The PTY runner is verified only on Linux.";
      shared.sessions.set(home, { state: "unavailable", reason });
      throw new LaunchFailure("unavailable", reason);
    }

    let windows: string[];
    try {
      windows = (this.options.listWindows ?? listTmuxWindows)(this.env, true);
    } catch {
      throw new StartRefusal("tmux-unknown");
    }
    if (windows.includes(agent)) throw new StartRefusal("tmux-active");

    const sessionId = randomUUID();
    const spec: SessionSpec = {
      command: "claude", args: ["--session-id", sessionId, "-n", agent],
      cwd: home, env: launchEnvironment(this.env, home),
    };
    const launchSpec = this.options.launchSpec?.(spec) ?? spec;
    let screen: RunnerScreen;
    try {
      screen = (this.options.createScreen ?? createRunnerScreen)(launchSpec);
    } catch (error) {
      const reason = "Could not load the PTY screen buffer.";
      shared.sessions.set(home, { state: "unavailable", reason });
      throw new LaunchFailure("unavailable", reason, error);
    }
    let lock;
    try {
      lock = this.claimLock(home, sessionId);
    } catch (error) {
      screen.dispose();
      throw error;
    }
    const runner = new PtyRunner();
    const session: ActiveSession = { state: "starting", runner, screen, outputVersion: 0, settled: Promise.resolve() };
    shared.sessions.set(home, session);
    runner.output().on("data", (chunk: Uint8Array) => {
      if (chunk.byteLength === 0) return;
      session.outputVersion++;
      session.unansweredSince = undefined;
      screen.write(chunk);
    });
    const launch = runner.launch(launchSpec, (pid) => lock.spawned(pid));
    session.settled = this.recordExit(home, session, lock);
    void session.settled.catch(() => {});
    try {
      await launch;
      if (session.state === "starting") session.state = "running";
    } catch (error) {
      await session.settled;
      if (error instanceof LaunchFailure && error.reason === "unavailable") {
        shared.sessions.set(home, { state: "unavailable", reason: error.message });
      }
      throw error;
    }
  }

  private claimLock(home: string, sessionId: string) {
    try {
      return claimRunnerLock(join(home, lockName), sessionId, this.now());
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new StartRefusal("locked");
      throw new LaunchFailure("start-failed", "Could not claim the runner lock.", error);
    }
  }

  private async recordExit(home: string, session: ActiveSession, lock: ReturnType<typeof claimRunnerLock>) {
    const exit = await session.runner.exited().catch((error: unknown) => {
      session.state = "stopping";
      lock.retain();
      throw error;
    }).finally(() => session.screen.dispose());
    session.state = "stopping";
    const exitedAt = this.now();
    await lock.release();
    shared.sessions.set(home, { state: "stopped", code: exit.code, exitedAt });
  }

  async write(agent: string, text: string): Promise<WriteResult> {
    const session = this.session(agent);
    if (!session || !("runner" in session) || session.state !== "running" || session.submission) {
      return { status: "refused", reason: "not-running" };
    }
    return this.writeSession(session, text);
  }

  private async writeSession(session: ActiveSession, text: string): Promise<WriteResult> {
    const { outputVersion } = session;
    const sentAt = this.now();
    const result = await session.runner.write(text);
    if (result.status === "written" && outputVersion === session.outputVersion) session.unansweredSince ??= sentAt;
    return result;
  }

  async submit(agent: string, text: string): Promise<SendKeysResult> {
    const session = this.session(agent);
    if (!isPtyOptedIn(this.env, agent) || !session || !("runner" in session) || session.state !== "running") {
      return { status: "not-submitted", reason: "window-not-live", error: "The PTY session is not running or no longer opted in.", enterAttempts: 0 };
    }
    if (session.submission) {
      return { status: "not-attempted", reason: "unsafe-composer", error: "A PTY send is already in progress.", enterAttempts: 0 };
    }
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)) {
      return { status: "not-attempted", reason: "unsafe-composer", error: "The text contains unsafe control characters.", enterAttempts: 0 };
    }
    const submission = { cancelled: false };
    session.submission = submission;
    const canUseSession = () => !submission.cancelled && session.state === "running" &&
      this.session(agent) === session && isPtyOptedIn(this.env, agent);
    try {
      return await submitPaneText(text, {
        capture: () => canUseSession() ? session.screen.composer() : undefined,
        sendText: async (payload) => canUseSession() &&
          (await this.writeSession(session, `\x1b[200~${payload}\x1b[201~`)).status === "written",
        pressEnter: async () => canUseSession() && (await session.runner.key("Enter")).status === "written",
        wait: (ms) => delay(ms),
        verifyPastedText: true,
      }, { enterDelayMs: SEND_KEYS_ENTER_DELAY_MS, verifyDelaysMs: SEND_KEYS_VERIFY_DELAYS_MS });
    } finally {
      session.submission = undefined;
    }
  }

  async key(agent: string, name: PaneKey): Promise<WriteResult> {
    const session = this.session(agent);
    if (!session || !("runner" in session) || session.state !== "running" || !isPtyOptedIn(this.env, agent)) {
      return { status: "refused", reason: "not-running" };
    }
    return session.submission ? { status: "refused", reason: "unsafe-pane" } : session.runner.key(name);
  }

  async cancel(agent: string): Promise<boolean> {
    const session = this.session(agent);
    if (!session || !("runner" in session) || session.state !== "running") return false;
    if (session.submission) session.submission.cancelled = true;
    await session.runner.cancel();
    return true;
  }

  async stop(agent: string): Promise<void> {
    const session = this.session(agent);
    if (session && "runner" in session) await this.stopSession(session);
  }

  private async stopSession(session: ActiveSession): Promise<void> {
    session.state = "stopping";
    await session.runner.stop("graceful");
    await session.settled;
  }

  async shutdown(): Promise<void> {
    shared.closing = true;
    await Promise.all(Array.from(shared.sessions.values(), (session) =>
      "runner" in session ? this.stopSession(session) : undefined));
  }

  async recover(): Promise<void> {
    if (process.platform !== "linux") return;
    let root: string;
    let entries;
    try {
      root = realpathSync(agentsRoot(this.env));
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) shared.recoveryFailed = true;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !AGENT_NAME_RE.test(entry.name)) continue;
      const home = join(root, entry.name);
      try {
        if (await recoverRunnerLock(join(home, lockName))) {
          shared.sessions.set(home, { state: "stopped", code: null, exitedAt: this.now() });
        }
      } catch {
        const current = shared.sessions.get(home);
        if (!current || !("runner" in current)) {
          shared.sessions.set(home, { state: "locked", reason: "Could not safely recover the runner lock." });
        }
      }
    }
  }
}

export const runnerRegistry = new RunnerRegistry();
