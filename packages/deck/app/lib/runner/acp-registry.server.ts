import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpSession, type AcpAdapter } from "../acp-session.server.js";
import { resolveAgentsRoot } from "../agent-model.server.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import { listTmuxWindows } from "../tmux.server.js";
import {
  antigravity1Manifest, checkAgyVersion, isAcpOptedIn, resolveAcpExecutable,
  type AcpAdapterManifest,
} from "./acp-manifest.js";
import { claimRunnerLock, hasCode, recoverRunnerLock } from "./lock.server.js";
import { StartRefusal } from "./registry.server.js";
import { LaunchFailure, signalGroup } from "./runner.js";

const lockName = ".runner.lock";

export type AcpActiveSession = {
  state: "starting" | "running" | "stopping";
  session: AcpSession;
  pid: number;
  home: string;
  manifest: AcpAdapterManifest;
  settled: Promise<void>;
};

export type AcpCleanupSession = {
  state: "cleanup-pending";
  retry: () => Promise<void>;
};

export type AcpInactiveSession =
  | { state: "stopped"; code: number | null; exitedAt: number }
  | { state: "locked"; reason: string }
  | { state: "unavailable"; reason: string };

export type AcpSessionStatus =
  | { state: AcpActiveSession["state"] | AcpCleanupSession["state"] }
  | AcpInactiveSession;

const registryKey = Symbol.for("inkie-deck.acp.registry");
const globals = globalThis as typeof globalThis & {
  [registryKey]?: {
    sessions: Map<string, AcpActiveSession | AcpCleanupSession | AcpInactiveSession>;
    closing: boolean;
    recoveryFailed: false | symbol;
  };
};
const shared = globals[registryKey] ??= { sessions: new Map(), closing: false, recoveryFailed: false };

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

export interface AcpRegistryOptions {
  manifest?: AcpAdapterManifest;
  listWindows?: typeof listTmuxWindows;
  now?: () => number;
  dataRoot?: string;
  allowVersionMismatch?: boolean;
  execVersion?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  startSession?: (adapter: AcpAdapter, options: {
    cwd: string;
    dataRoot: string;
    onSpawn?: (pid: number) => void;
  }) => Promise<AcpSession>;
}

export class AcpRunnerRegistry {
  private readonly now: () => number;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: AcpRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private session(agent: string) {
    const home = agentHome(this.env, agent);
    return home === undefined ? undefined : shared.sessions.get(home);
  }

  isOptedIn(agent: string): boolean {
    return isAcpOptedIn(this.env, agent);
  }

  canControl(agent: string): boolean {
    const session = this.session(agent);
    return session !== undefined && ("session" in session || session.state === "cleanup-pending");
  }

  status(agent: string): AcpSessionStatus | undefined {
    const session = this.session(agent);
    if (session?.state === "cleanup-pending") return { state: session.state };
    if (!session || !("session" in session)) return session;
    return { state: session.state };
  }

  async start(agent: string): Promise<AcpSession> {
    return this.startAgent(agent, true);
  }

  private async startAgent(agent: string, retryRecovery: boolean): Promise<AcpSession> {
    if (shared.closing) throw new StartRefusal("shutting-down");
    const home = this.isOptedIn(agent) ? agentHome(this.env, agent) : undefined;
    if (!home) throw new StartRefusal("not-opted-in");

    if (retryRecovery) {
      const retryRoot = shared.recoveryFailed;
      if (retryRoot) await this.recover();
      const lockedHomes = Array.from(shared.sessions).filter(([, session]) => session.state === "locked");
      for (const [lockedHome] of lockedHomes) await this.recoverHome(lockedHome);
      if (retryRoot || lockedHomes.length > 0) return this.startAgent(agent, false);
    }

    if (shared.recoveryFailed) throw new StartRefusal("locked");
    for (const session of shared.sessions.values()) {
      if ("session" in session) throw new StartRefusal("busy");
      if (session.state === "locked" || session.state === "cleanup-pending") throw new StartRefusal("locked");
    }

    if (process.platform !== "linux" && process.platform !== "darwin") {
      const reason = "The ACP runner requires a POSIX process group environment.";
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

    const manifest = this.options.manifest ?? antigravity1Manifest;
    const executable = resolveAcpExecutable(manifest.executableName, this.env, home);
    checkAgyVersion(executable, manifest.semverFloor, {
      allowMismatch: this.options.allowVersionMismatch,
      exec: this.options.execVersion,
    });

    const sessionId = randomUUID();
    let lock;
    try {
      lock = this.claimLock(home, sessionId);
    } catch (error) {
      if (retryRecovery && error instanceof StartRefusal && error.reason === "locked") {
        await this.recoverHome(home);
        return this.startAgent(agent, false);
      }
      throw error;
    }

    lock.beforeSpawn();

    let childPid = 0;
    const adapter: AcpAdapter = {
      executable,
      args: manifest.args,
      version: manifest.semverFloor,
      environment: manifest.envAllowlist,
      knownExtensions: manifest.knownExtensions,
    };

    const sessionOptions = {
      cwd: home,
      dataRoot: this.options.dataRoot ?? home,
      onSpawn: (pid: number) => {
        childPid = pid;
        lock.spawned(pid);
      },
    };

    let session: AcpSession;
    try {
      if (this.options.startSession) {
        session = await this.options.startSession(adapter, sessionOptions);
      } else {
        session = await AcpSession.start(adapter, sessionOptions);
      }
    } catch (error) {
      try {
        if (childPid > 0) {
          signalGroup(childPid, "SIGKILL");
        }
        await lock.release();
      } catch {}
      throw error;
    }

    const activeSession: AcpActiveSession = {
      state: "running",
      session,
      pid: childPid,
      home,
      manifest,
      settled: Promise.resolve(),
    };
    shared.sessions.set(home, activeSession);

    activeSession.settled = this.recordExit(home, activeSession, lock);
    void activeSession.settled.catch(() => {});

    return session;
  }

  private claimLock(home: string, sessionId: string) {
    try {
      return claimRunnerLock(join(home, lockName), sessionId, this.now());
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new StartRefusal("locked");
      throw new LaunchFailure("start-failed", "Could not claim the runner lock.", error);
    }
  }

  private async recordExit(home: string, session: AcpActiveSession, lock: ReturnType<typeof claimRunnerLock>) {
    let exitCode: number | null = null;
    try {
      await session.session.exited;
    } catch (error) {
      session.state = "stopping";
      lock.retain();
      throw error;
    }

    const exitedAt = this.now();
    let pending: Promise<void> | undefined;
    const cleanup: AcpCleanupSession = {
      state: "cleanup-pending",
      retry: () => pending ??= lock.release().then(() => {
        shared.sessions.set(home, { state: "stopped", code: exitCode, exitedAt });
      }).finally(() => { pending = undefined; }),
    };
    shared.sessions.set(home, cleanup);
    await cleanup.retry();
  }

  async cancel(agent: string): Promise<boolean> {
    const session = this.session(agent);
    if (!session || !("session" in session) || session.state !== "running") return false;
    await session.session.cancel();
    return true;
  }

  async stop(agent: string): Promise<void> {
    const session = this.session(agent);
    if (session && "session" in session) await this.stopSession(session);
    else if (session?.state === "cleanup-pending") await session.retry();
  }

  private async stopSession(session: AcpActiveSession): Promise<void> {
    session.state = "stopping";
    if (session.pid > 0) {
      signalGroup(session.pid, "SIGTERM");
      let stopped = false;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(-session.pid, 0);
          await delay(25);
        } catch (err) {
          if (hasCode(err, "ESRCH")) {
            stopped = true;
            break;
          }
        }
      }
      if (!stopped) {
        signalGroup(session.pid, "SIGKILL");
      }
    }
    await session.session.cancel().catch(() => {});
    await session.settled;
  }

  async shutdown(): Promise<void> {
    shared.closing = true;
    await Promise.all(Array.from(shared.sessions.values(), (session) =>
      "session" in session ? this.stopSession(session) : session.state === "cleanup-pending" ? session.retry() : undefined));
  }

  private async recoverHome(home: string): Promise<void> {
    const existing = shared.sessions.get(home);
    if (existing && ("session" in existing || existing.state === "cleanup-pending")) return;
    try {
      const result = await recoverRunnerLock(join(home, lockName));
      if (shared.sessions.get(home) !== existing) return;
      if (result === "recovered") {
        shared.sessions.set(home, { state: "stopped", code: null, exitedAt: this.now() });
      } else if (result === "absent" && existing?.state === "locked") {
        shared.sessions.delete(home);
      }
    } catch {
      if (shared.sessions.get(home) === existing) {
        shared.sessions.set(home, { state: "locked", reason: "Could not safely recover the runner lock." });
      }
    }
  }

  async recover(): Promise<void> {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const previousFailure = shared.recoveryFailed;
    let root: string;
    let entries;
    try {
      root = realpathSync(agentsRoot(this.env));
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) shared.recoveryFailed = Symbol();
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !AGENT_NAME_RE.test(entry.name)) continue;
      const home = join(root, entry.name);
      await this.recoverHome(home);
    }
    if (shared.recoveryFailed === previousFailure) shared.recoveryFailed = false;
  }
}

export const acpRunnerRegistry = new AcpRunnerRegistry();
