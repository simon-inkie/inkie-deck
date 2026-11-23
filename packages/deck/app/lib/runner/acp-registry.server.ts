import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { AcpSession, type AcpAdapter } from "../acp-session.server.js";
import { resolveAgentsRoot } from "../agent-model.server.js";
import type { DeckEvent } from "../deck-event.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import { listTmuxWindows, resolveTmuxSession } from "../tmux.server.js";
import {
  antigravity1Manifest,
  isAcpOptedIn,
  probeAgyVersion,
  resolveAcpExecutable,
  statExecutableIdentity,
  type AcpAdapterManifest,
  type ExecutableIdentity,
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
  usesAcpSession: boolean;
  pid: number;
  home: string;
  manifest: AcpAdapterManifest;
  abortController: AbortController;
  settled: Promise<void>;
  stopPromise?: Promise<void>;
  events: DeckEvent[];
  pendingPermissions: Map<string, DeckEvent>;
  latestBlockingCard?: DeckEvent;
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

/**
 * Resolve the literal .acp-last-session path directly inside realpath(home) WITHOUT
 * resolving the child component, so symlinks inside home are caught by lstat/O_NOFOLLOW.
 */
function literalSessionFile(home: string): string {
  const realHome = realpathSync(home);
  return join(realHome, lastSessionName);
}

function readStoredSessionId(home: string): string | undefined {
  try {
    const file = literalSessionFile(home);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > 256) return undefined;
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile() || fdStat.nlink > 1 || fdStat.size > 256) return undefined;
      // Major 4: Bounded fixed-size read (never reads arbitrarily large files on poll)
      const buf = Buffer.allocUnsafe(256);
      const n = readSync(fd, buf, 0, 256, 0);
      // Major 3: Strip only trailing newline so printable leading/trailing spaces round-trip verbatim
      const value = buf.subarray(0, n).toString("utf8").replace(/\r?\n$/, "");
      return value.length > 0 && value.length <= 128 && !/[^ -~]/.test(value) ? value : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function clearStoredSessionId(home: string): void {
  try {
    const file = literalSessionFile(home);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1) {
      unlinkSync(file);
    }
  } catch {
    // Best-effort cleanup of stale metadata.
  }
}

/**
 * Major 4: Atomic temp-file + rename write so an existing or concurrently created
 * hard-linked inode or symlink can NEVER be modified in place.
 */
function writeStoredSessionId(home: string, sessionId: string): void {
  try {
    const realHome = realpathSync(home);
    const file = join(realHome, lastSessionName);
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) {
      return;
    }
    const tmp = join(realHome, `${lastSessionName}.tmp.${randomUUID()}`);
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0);
    const fd = openSync(tmp, flags, 0o600);
    let renamed = false;
    try {
      try {
        const bytes = Buffer.from(sessionId + "\n", "utf8");
        writeSync(fd, bytes, 0, bytes.length, 0);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
      renamed = true;
    } finally {
      if (!renamed) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup error */ }
      }
    }
  } catch {
    // Refuse symlink/hard-link/invalid targets silently without crashing session startup.
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
      const protectedEvents: DeckEvent[] = [];
      for (const perm of entry.pendingPermissions.values()) {
        if (!seen.has(perm.id)) {
          protectedEvents.push(perm);
          seen.add(perm.id);
        }
      }
      if (entry.latestBlockingCard && !seen.has(entry.latestBlockingCard.id)) {
        protectedEvents.push(entry.latestBlockingCard);
      }
      return [...protectedEvents, ...entry.events];
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
    if (shared.closing) throw new StartRefusal("shutting-down");
    const home = this.isOptedIn(agent) ? agentHome(this.env, agent) : undefined;
    if (!home) throw new StartRefusal("not-opted-in");

    // Check active ACP sessions / cleanup-pending across homes BEFORE publishing reservation
    for (const session of shared.sessions.values()) {
      if ("abortController" in session) throw new StartRefusal("busy");
      if (session.state === "cleanup-pending") throw new StartRefusal("locked");
    }

    if (process.platform !== "linux") {
      const reason = "The ACP runner requires Linux (/proc and flock).";
      shared.sessions.set(home, { state: "unavailable", reason });
      throw new LaunchFailure("unavailable", reason);
    }

    // Fail fast on explicit resume with no valid saved checkpoint (never fall back to session/new)
    const resumeSessionId = options.resume ? readStoredSessionId(home) : undefined;
    if (options.resume && !resumeSessionId) {
      throw new LaunchFailure("start-failed", "No valid saved session checkpoint to resume.");
    }

    const priorEntry = shared.sessions.get(home);
    const manifest = this.options.manifest ?? antigravity1Manifest;
    const abortController = new AbortController();
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });

    // Publish 'starting' reservation synchronously BEFORE any async recovery, probe, lock, or spawn
    // so stop()/shutdown() ALWAYS sees and cancels an in-flight start (even when prior state was 'locked').
    const activeSession: AcpActiveSession = {
      state: "starting",
      usesAcpSession: !this.options.startSession,
      pid: 0,
      home,
      manifest,
      abortController,
      settled: settledPromise,
      events: [],
      pendingPermissions: new Map(),
    };
    shared.sessions.set(home, activeSession);

    const clearReservation = (restore?: AcpInactiveSession) => {
      if (shared.sessions.get(home) === activeSession) {
        if (restore) shared.sessions.set(home, restore);
        else shared.sessions.delete(home);
      }
      resolveSettled();
    };

    // Perform any needed boot/lock recovery UNDER the published reservation so Stop can cancel it
    try {
      if (shared.recoveryFailed) {
        await this.recover();
        if (abortController.signal.aborted || shared.closing) {
          clearReservation();
          throw new StartRefusal("shutting-down");
        }
        if (shared.recoveryFailed) {
          clearReservation();
          throw new StartRefusal("locked");
        }
      }

      if (priorEntry?.state === "locked") {
        try {
          await recoverRunnerLock(join(home, lockName));
        } catch {
          clearReservation({ state: "locked", reason: "Could not safely recover the runner lock." });
          throw new StartRefusal("locked");
        }
        if (abortController.signal.aborted || shared.closing) {
          clearReservation();
          throw new StartRefusal("shutting-down");
        }
      }

      this.assertNoTmuxWindow(agent);
    } catch (error) {
      clearReservation();
      throw error;
    }

    let executable: string;
    let execIdentity: ExecutableIdentity;
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
      if (error instanceof StartRefusal && error.reason === "locked") {
        try {
          await recoverRunnerLock(join(home, lockName));
        } catch {
          clearReservation({ state: "locked", reason: "Could not safely recover the runner lock." });
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

    // Re-verify opt-in, tmux window absence, and pinned executable identity (dev, ino, size, mtimeMs, sha256) AFTER lock claim
    try {
      if (!this.isOptedIn(agent)) {
        throw new StartRefusal("not-opted-in");
      }
      this.assertNoTmuxWindow(agent);
      const currentIdentity = statExecutableIdentity(executable);
      if (
        currentIdentity.dev !== execIdentity.dev ||
        currentIdentity.ino !== execIdentity.ino ||
        currentIdentity.size !== execIdentity.size ||
        currentIdentity.mtimeMs !== execIdentity.mtimeMs ||
        currentIdentity.sha256 !== execIdentity.sha256
      ) {
        throw new LaunchFailure("unavailable", "ACP executable changed between version probe and launch.");
      }
    } catch (error) {
      // Major 8: Route post-claim lock cleanup through cleanupFailedStart so failed release exposes cleanup-pending retry
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      throw error;
    }

    const adapter: AcpAdapter = {
      executable,
      args: manifest.args,
      version: detectedVersion || manifest.semverFloor,
      environment: manifest.envAllowlist,
      knownExtensions: manifest.knownExtensions,
    };

    const sessionOptions = {
      cwd: home,
      dataRoot: this.options.dataRoot ?? home,
      sessionMarker: sessionId,
      resumeSessionId,
      signal: abortController.signal,
      onEvent: (event: DeckEvent) => {
        if (event.type === "permission.requested") {
          activeSession.pendingPermissions.set(event.id, event);
        } else if (event.type === "permission.answered" && event.answers) {
          activeSession.pendingPermissions.delete(event.answers);
        } else if (event.type === "extension.blocking") {
          // Major 4: Retain latest blocking card (1 slot) and replace any prior deduped blocking card in ring
          activeSession.latestBlockingCard = event;
          if (event.dedupeKey) {
            const idx = activeSession.events.findIndex((e) => e.dedupeKey === event.dedupeKey);
            if (idx !== -1) activeSession.events.splice(idx, 1);
          }
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

    activeSession.session = session;
    const terminalKind = session.state.kind;
    if (terminalKind === "unsupported" || terminalKind === "failed" || terminalKind === "disconnected") {
      // Major 3: Clear stale checkpoint ONLY when resume was explicitly rejected (no resume capability or session-not-found),
      // NEVER on a temporary protocol-version mismatch or transient transport disconnect!
      if (options.resume && session.resumeRejected) {
        clearStoredSessionId(home);
      }
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

    activeSession.state = "running";
    // Persist .acp-last-session ONLY when agent advertised resume/load capability; clear stale metadata otherwise
    if (session.activeSessionId && session.supportsResume?.()) {
      writeStoredSessionId(home, session.activeSessionId);
    } else {
      clearStoredSessionId(home);
    }

    const exitSettled = this.recordExit(home, activeSession, lock).finally(() => resolveSettled());
    activeSession.settled = exitSettled;
    void exitSettled.catch(() => {});

    return session;
  }

  private assertNoTmuxWindow(agent: string): void {
    const list = this.options.listWindows ?? listTmuxWindows;
    const configuredSession = resolveTmuxSession(this.env);
    let windows: string[];
    try {
      windows = list(this.env, true);
      // Major 1: Base's boot-agents.sh & workspace.sh always use the "agents" session;
      // if MC_TMUX_SESSION points elsewhere, check Base's "agents" session too so both runners cannot overlap.
      if (configuredSession !== "agents") {
        const baseWindows = list({ ...this.env, MC_TMUX_SESSION: "agents" }, true);
        windows = [...windows, ...baseWindows];
      }
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
    // Single termination owner: AcpSession owns its child process group when constructed.
    // Only signal raw pid if a custom startSession failed before returning a session object.
    if (!activeSession.session && activeSession.pid > 0) {
      signalGroup(activeSession.pid, "SIGKILL");
      activeSession.pid = 0;
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
      // Major 2: Single termination owner. When usesAcpSession is true, abortController.abort()
      // triggers AcpSession's own abort listener during negotiation and session.close() owns running teardown.
      // Never fire a second raw-PID SIGKILL on top of AcpSession!
      activeSession.abortController.abort();
      if (activeSession.session?.close) {
        await activeSession.session.close().catch(() => {});
      } else if (!activeSession.usesAcpSession && activeSession.pid > 0) {
        signalGroup(activeSession.pid, "SIGKILL");
        activeSession.pid = 0;
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
