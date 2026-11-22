import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpSession, type AcpAdapter } from "../acp-session.server.js";
import { resolveAgentsRoot } from "../agent-model.server.js";
import type { DeckEvent } from "../deck-event.js";
import { AGENT_NAME_RE, confineToRoot } from "../safe-fs.server.js";
import { listTmuxWindows } from "../tmux.server.js";
import {
  antigravity1Manifest,
  isAcpOptedIn,
  probeAgyVersion,
  resolveAcpExecutable,
  statExecutableIdentity,
  type AcpAdapterManifest,
} from "./acp-manifest.js";
import { claimRunnerLock, hasCode, recoverRunnerLock } from "./lock.server.js";
import { StartRefusal } from "./registry.server.js";
import { LaunchFailure, signalGroup } from "./runner.js";

const lockName = ".runner.lock";
const lastSessionName = ".acp-last-session";
const MAX_EVENTS_PER_SESSION = 500;

export type AcpActiveSession = {
  state: "starting" | "running" | "stopping";
  session?: AcpSession;
  pid: number;
  home: string;
  manifest: AcpAdapterManifest;
  abortController: AbortController;
  settled: Promise<void>;
  stopPromise?: Promise<void>;
  events: DeckEvent[];
  pendingPermissions: Map<string, DeckEvent>;
};

export type AcpCleanupSession = {
  state: "cleanup-pending";
  retry: () => Promise<void>;
};

export type AcpInactiveSession =
  | { state: "stopped"; code: number | null; signal?: NodeJS.Signals | null; exitedAt: number; events?: DeckEvent[] }
  | { state: "locked"; reason: string }
  | { state: "unavailable"; reason: string };

export type AcpSessionStatus =
  | {
    state: AcpActiveSession["state"];
    capabilities?: ReturnType<AcpSession["capabilities"]["valueOf"]>;
    supportsResume?: boolean;
    queuedCount?: number;
    authRequired?: boolean;
    contextUsage?: { used: number; size: number };
  }
  | { state: AcpCleanupSession["state"] }
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

function homeWantsAcp(home: string): boolean {
  try {
    const info = lstatSync(join(home, ".runner"), { throwIfNoEntry: false });
    if (!info || !info.isFile()) return false;
    return readFileSync(join(home, ".runner"), "utf8").trim() === "acp";
  } catch {
    return false;
  }
}

function readStoredSessionId(home: string): string | undefined {
  try {
    const file = confineToRoot(join(home, lastSessionName), home, { label: "ACP session file", forWrite: false });
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return undefined;
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 && value.length <= 128 && !/[^ -~]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Major 4: Write .acp-last-session strictly confined inside home with O_NOFOLLOW
 * so a symlink in the workspace can NEVER be truncated or overwritten outside home.
 */
function writeStoredSessionId(home: string, sessionId: string): void {
  try {
    const file = confineToRoot(join(home, lastSessionName), home, { label: "ACP session file", forWrite: true });
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      return;
    }
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (fsConstants.O_NOFOLLOW ?? 0);
    const fd = openSync(file, flags, 0o600);
    try {
      const bytes = Buffer.from(sessionId + "\n", "utf8");
      writeSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Refuse symlink/invalid targets silently without crashing session startup.
  }
}

export interface AcpRegistryOptions {
  manifest?: AcpAdapterManifest;
  listWindows?: typeof listTmuxWindows;
  now?: () => number;
  dataRoot?: string;
  allowVersionMismatch?: boolean;
  execVersion?: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  startSession?: (adapter: AcpAdapter, options: {
    cwd: string;
    dataRoot: string;
    sessionMarker?: string;
    resumeSessionId?: string;
    signal?: AbortSignal;
    onEvent?: (event: DeckEvent) => void;
    onBeforeSpawn?: () => void;
    onSpawn?: (pid: number) => void;
    onSpawnFailed?: () => void;
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
    return session !== undefined && ("abortController" in session || session.state === "cleanup-pending");
  }

  /**
   * Major 2: Expose active session ONLY while state === "running" (never during "stopping" grace period).
   */
  getActiveSession(agent: string): AcpSession | undefined {
    const entry = this.session(agent);
    if (!entry || !("abortController" in entry) || entry.state !== "running") return undefined;
    return entry.session;
  }

  /**
   * Major 2: Return retained events plus any pending (unanswered) permission cards that are
   * protected from 500-event ring eviction.
   */
  events(agent: string): DeckEvent[] {
    const entry = this.session(agent);
    if (!entry) return [];
    if ("abortController" in entry) {
      const seen = new Set(entry.events.map((e: DeckEvent) => e.id));
      const protectedPending: DeckEvent[] = [];
      for (const perm of entry.pendingPermissions.values()) {
        if (!seen.has(perm.id)) protectedPending.push(perm);
      }
      return [...protectedPending, ...entry.events];
    }
    if (entry.state === "stopped" && entry.events) return [...entry.events];
    return [];
  }

  lastSessionId(agent: string): string | undefined {
    const home = agentHome(this.env, agent);
    return home ? readStoredSessionId(home) : undefined;
  }

  status(agent: string): AcpSessionStatus | undefined {
    const session = this.session(agent);
    if (!session) return undefined;
    if (session.state === "cleanup-pending") return { state: session.state };
    if (!("abortController" in session)) return session;
    return {
      state: session.state,
      capabilities: session.session?.capabilities,
      supportsResume: session.session?.supportsResume?.() ?? false,
      queuedCount: session.session?.queuedCount ?? 0,
      authRequired: session.session?.authRequired ?? false,
      contextUsage: session.session?.contextUsage,
    };
  }

  async start(agent: string, options: { resume?: boolean } = {}): Promise<AcpSession> {
    return this.startAgent(agent, true, options);
  }

  private async startAgent(agent: string, retryRecovery: boolean, startOpts: { resume?: boolean }): Promise<AcpSession> {
    if (shared.closing) throw new StartRefusal("shutting-down");
    const home = this.isOptedIn(agent) ? agentHome(this.env, agent) : undefined;
    if (!home) throw new StartRefusal("not-opted-in");

    if (retryRecovery) {
      const retryRoot = shared.recoveryFailed;
      if (retryRoot) await this.recover();
      const targetEntry = shared.sessions.get(home);
      if (targetEntry?.state === "locked") await this.recoverHome(home);
      if (retryRoot || targetEntry?.state === "locked") return this.startAgent(agent, false, startOpts);
    }

    if (shared.recoveryFailed) throw new StartRefusal("locked");

    // Major 8: Check active ACP sessions across all homes (single-ACP-agent limit),
    // but check `locked` ONLY for this home (so an unrelated malformed PTY home cannot block ACP).
    for (const [entryHome, session] of shared.sessions.entries()) {
      if ("abortController" in session) throw new StartRefusal("busy");
      if (session.state === "cleanup-pending") throw new StartRefusal("locked");
      if (entryHome === home && session.state === "locked") throw new StartRefusal("locked");
    }

    if (process.platform !== "linux") {
      const reason = "The ACP runner requires Linux (/proc and flock).";
      shared.sessions.set(home, { state: "unavailable", reason });
      throw new LaunchFailure("unavailable", reason);
    }

    this.assertNoTmuxWindow(agent);

    const manifest = this.options.manifest ?? antigravity1Manifest;
    const abortController = new AbortController();
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });

    // Reserve 'starting' synchronously BEFORE any async probe, recovery, lock, or spawn so
    // concurrent starts are refused as 'busy' and stop()/shutdown() can cancel in-flight starts.
    const activeSession: AcpActiveSession = {
      state: "starting",
      pid: 0,
      home,
      manifest,
      abortController,
      settled: settledPromise,
      events: [],
      pendingPermissions: new Map(),
    };
    shared.sessions.set(home, activeSession);

    const clearReservation = () => {
      if (shared.sessions.get(home) === activeSession) {
        shared.sessions.delete(home);
      }
      resolveSettled();
    };

    let executable: string;
    let execIdentity: { dev: number; ino: number };
    let detectedVersion: string;
    try {
      executable = resolveAcpExecutable(manifest.executableName, this.env, home);
      execIdentity = statExecutableIdentity(executable);
      const versionInfo = await probeAgyVersion(executable, manifest.semverFloor, {
        allowMismatch: this.options.allowVersionMismatch,
        cwd: home,
        env: this.env,
        extraEnvAllowlist: manifest.envAllowlist,
        signal: abortController.signal,
        exec: this.options.execVersion,
      });
      detectedVersion = versionInfo.version;
      if (abortController.signal.aborted || shared.closing) {
        clearReservation();
        throw new StartRefusal("shutting-down");
      }
      // Major 7: Re-verify opt-in AFTER async version probe (catches cutover to tmux mid-probe)
      if (!this.isOptedIn(agent)) {
        clearReservation();
        throw new StartRefusal("not-opted-in");
      }
    } catch (error) {
      clearReservation();
      throw error;
    }

    const sessionId = randomUUID();
    let lock: ReturnType<typeof claimRunnerLock>;
    try {
      lock = this.claimLock(home, sessionId);
    } catch (error) {
      if (retryRecovery && error instanceof StartRefusal && error.reason === "locked") {
        // Major 6: Keep the 'starting' reservation alive while recovering stale lock so stop() cannot miss us!
        try {
          await recoverRunnerLock(join(home, lockName));
        } catch {
          clearReservation();
          shared.sessions.set(home, { state: "locked", reason: "Could not safely recover the runner lock." });
          throw new StartRefusal("locked");
        }
        if (abortController.signal.aborted || shared.closing) {
          clearReservation();
          throw new StartRefusal("shutting-down");
        }
        try {
          lock = this.claimLock(home, sessionId);
        } catch (retryErr) {
          clearReservation();
          throw retryErr;
        }
      } else {
        clearReservation();
        throw error;
      }
    }

    // Major 7 & 9: Re-verify opt-in, tmux window absence, and pinned executable identity AFTER lock claim.
    try {
      if (!this.isOptedIn(agent)) {
        throw new StartRefusal("not-opted-in");
      }
      this.assertNoTmuxWindow(agent);
      const currentIdentity = statExecutableIdentity(executable);
      if (currentIdentity.dev !== execIdentity.dev || currentIdentity.ino !== execIdentity.ino) {
        throw new LaunchFailure("unavailable", "ACP executable changed between version probe and launch.");
      }
    } catch (error) {
      await lock.release().catch(() => lock.retain());
      clearReservation();
      throw error;
    }

    const adapter: AcpAdapter = {
      executable,
      args: manifest.args,
      version: detectedVersion || manifest.semverFloor,
      environment: manifest.envAllowlist,
      knownExtensions: manifest.knownExtensions,
    };

    const resumeSessionId = startOpts.resume ? readStoredSessionId(home) : undefined;
    const sessionOptions = {
      cwd: home,
      dataRoot: this.options.dataRoot ?? home,
      sessionMarker: sessionId,
      resumeSessionId,
      signal: abortController.signal,
      onEvent: (event: DeckEvent) => {
        // Major 2: Track pending permissions separately so 500-event ring eviction never loses an open permission
        if (event.type === "permission.requested") {
          activeSession.pendingPermissions.set(event.id, event);
        } else if (event.type === "permission.answered" && event.answers) {
          activeSession.pendingPermissions.delete(event.answers);
        }
        activeSession.events.push(event);
        if (activeSession.events.length > MAX_EVENTS_PER_SESSION) {
          activeSession.events.shift();
        }
      },
      onBeforeSpawn: () => {
        lock.beforeSpawn();
      },
      onSpawn: (pid: number) => {
        activeSession.pid = pid;
        lock.spawned(pid);
      },
      onSpawnFailed: () => {
        // Major 5: Confirmed failed exec with no PID -> revert 'spawning' to 'reserved' so lock.release() succeeds cleanly
        lock.failedBeforeSpawn();
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
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      throw error;
    }

    const terminalKind = session.state.kind;
    if (terminalKind === "unsupported" || terminalKind === "failed" || terminalKind === "disconnected") {
      await session.close().catch(() => {});
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      if (terminalKind === "unsupported") {
        throw new LaunchFailure("unavailable", "Agent does not support the required ACP protocol version or capability.");
      }
      throw new LaunchFailure("start-failed", `ACP session negotiation ended in state '${terminalKind}'.`);
    }

    if (abortController.signal.aborted || shared.closing) {
      await session.close().catch(() => {});
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      throw new StartRefusal("shutting-down");
    }

    activeSession.session = session;
    activeSession.state = "running";
    // Major 3 & 4: Persist .acp-last-session ONLY when agent advertised resume/load capability, using O_NOFOLLOW
    if (session.activeSessionId && session.supportsResume?.()) {
      writeStoredSessionId(home, session.activeSessionId);
    }

    const exitSettled = this.recordExit(home, activeSession, lock).finally(() => resolveSettled());
    activeSession.settled = exitSettled;
    void exitSettled.catch(() => {});

    return session;
  }

  private assertNoTmuxWindow(agent: string): void {
    let windows: string[];
    try {
      windows = (this.options.listWindows ?? listTmuxWindows)(this.env, true);
    } catch {
      throw new StartRefusal("tmux-unknown");
    }
    if (windows.includes(agent)) throw new StartRefusal("tmux-active");
  }

  private async cleanupFailedStart(
    home: string,
    activeSession: AcpActiveSession,
    lock: ReturnType<typeof claimRunnerLock>,
  ): Promise<void> {
    if (activeSession.pid > 0) {
      signalGroup(activeSession.pid, "SIGKILL");
    }
    try {
      await lock.release();
      if (shared.sessions.get(home) === activeSession) {
        shared.sessions.set(home, {
          state: "stopped",
          code: activeSession.session?.exitInfo.code ?? null,
          signal: activeSession.session?.exitInfo.signal ?? null,
          exitedAt: this.now(),
          events: activeSession.events,
        });
      }
    } catch {
      let pending: Promise<void> | undefined;
      const cleanup: AcpCleanupSession = {
        state: "cleanup-pending",
        retry: () => pending ??= (async () => {
          if (activeSession.pid > 0) signalGroup(activeSession.pid, "SIGKILL");
          await lock.release();
          shared.sessions.set(home, {
            state: "stopped",
            code: activeSession.session?.exitInfo.code ?? null,
            signal: activeSession.session?.exitInfo.signal ?? null,
            exitedAt: this.now(),
            events: activeSession.events,
          });
        })().finally(() => { pending = undefined; }),
      };
      shared.sessions.set(home, cleanup);
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

  private async recordExit(home: string, activeSession: AcpActiveSession, lock: ReturnType<typeof claimRunnerLock>) {
    try {
      await activeSession.session!.exited;
    } catch (error) {
      activeSession.state = "stopping";
      lock.retain();
      throw error;
    }

    const exitInfo = activeSession.session?.exitInfo ?? { code: null, signal: null };
    const exitedAt = this.now();
    let pending: Promise<void> | undefined;
    const cleanup: AcpCleanupSession = {
      state: "cleanup-pending",
      retry: () => pending ??= lock.release().then(() => {
        shared.sessions.set(home, {
          state: "stopped",
          code: exitInfo.code,
          signal: exitInfo.signal,
          exitedAt,
          events: activeSession.events,
        });
      }).finally(() => { pending = undefined; }),
    };
    shared.sessions.set(home, cleanup);
    await cleanup.retry();
  }

  async cancel(agent: string): Promise<boolean> {
    const session = this.session(agent);
    if (!session || !("abortController" in session) || session.state !== "running" || !session.session) return false;
    await session.session.cancel();
    return true;
  }

  async stop(agent: string): Promise<void> {
    const session = this.session(agent);
    if (session && "abortController" in session) await this.stopSession(session);
    else if (session?.state === "cleanup-pending") await session.retry();
  }

  private stopSession(activeSession: AcpActiveSession): Promise<void> {
    if (activeSession.stopPromise) return activeSession.stopPromise;
    activeSession.stopPromise = (async () => {
      activeSession.state = "stopping";
      activeSession.abortController.abort();
      if (activeSession.pid > 0) {
        signalGroup(activeSession.pid, "SIGTERM");
        // Major 6: Stop polling as soon as child exit resolves so we never signal a recycled group ID
        let exited = false;
        const exitWatch = activeSession.session?.exited?.then(() => { exited = true; }).catch(() => { exited = true; });
        void exitWatch;
        for (let i = 0; i < 20 && !exited; i++) {
          try {
            process.kill(-activeSession.pid, 0);
            await delay(25);
          } catch (err) {
            if (hasCode(err, "ESRCH")) {
              exited = true;
              break;
            }
          }
        }
        if (!exited) {
          signalGroup(activeSession.pid, "SIGKILL");
        }
      }
      if (activeSession.session?.close) {
        await activeSession.session.close().catch(() => {});
      }
      await activeSession.settled.catch(() => {});
    })();
    return activeSession.stopPromise;
  }

  async shutdown(): Promise<void> {
    shared.closing = true;
    await Promise.all(Array.from(shared.sessions.values(), (session) =>
      "abortController" in session ? this.stopSession(session) : session.state === "cleanup-pending" ? session.retry() : undefined));
  }

  private async recoverHome(home: string): Promise<void> {
    const existing = shared.sessions.get(home);
    if (existing && ("abortController" in existing || existing.state === "cleanup-pending")) return;
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
    if (process.platform !== "linux") return;
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
      // Major 8: Only recover homes that opt into ACP (do not touch unrelated PTY homes)
      if (!homeWantsAcp(home)) continue;
      await this.recoverHome(home);
    }
    if (shared.recoveryFailed === previousFailure) shared.recoveryFailed = false;
  }
}

export const acpRunnerRegistry = new AcpRunnerRegistry();
