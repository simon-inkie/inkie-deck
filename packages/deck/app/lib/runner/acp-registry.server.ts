import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
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
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acpQuotaContext, readAcpUsageReading } from "../acp-usage.server.js";
import { AcpSession, buildAcpSessionEnv, type AcpAdapter } from "../acp-session.server.js";
import { resolveAgentsRoot } from "../agent-model.server.js";
import type { DeckEvent } from "../deck-event.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import { listTmuxWindows } from "../tmux.server.js";
import {
  antigravity1Manifest,
  resolveAcpManifestForAgent,
  isAcpOptedIn,
  probeAgyVersion,
  resolveAcpExecutable,
  statExecutableIdentity,
  type AcpAdapterManifest,
  type ExecutableIdentity,
  type UsageReading,
} from "./acp-manifest.js";
import { resolveAcpAgentHome as agentHome } from "./acp-manifest.server.js";
import {
  claimRunnerLock,
  hasCode,
  isRunnerGroupVerifiedAlive,
  killVerifiedRunnerGroup,
  readRunnerLockOwner,
  recoverRunnerLock,
  type RunnerGroupIdentity,
} from "./lock.server.js";
import { StartRefusal } from "./registry.server.js";
import { LaunchFailure, signalGroup } from "./runner.js";

const lockName = ".runner.lock";
const lastSessionName = ".acp-last-session";
const capabilitiesName = ".acp-capabilities";
const legacyAgyPrefix = `${antigravity1Manifest.name}:`;
const MAX_EVENTS_PER_SESSION = 500;
const MAX_SHUTDOWN_CLEANUP_ATTEMPTS = 3;
const SHUTDOWN_CLEANUP_RETRY_DELAY_MS = 50;

export type AcpActiveSession = {
  state: "starting" | "running" | "stopping";
  session?: AcpSession;
  usesAcpSession: boolean;
  pid: number;
  home: string;
  manifest: AcpAdapterManifest;
  codexQuotaContext?: string;
  abortController: AbortController;
  settled: Promise<void>;
  stopPromise?: Promise<void>;
  abandonOnUnkillable?: () => void;
  events: DeckEvent[];
  pendingPermissions: Map<string, DeckEvent>;
  latestBlockingCard?: DeckEvent;
};

export type AcpCleanupSession = {
  state: "cleanup-pending";
  events?: DeckEvent[];
  retry: () => Promise<void>;
  abandon: () => void;
};

export type AcpOrphanedSession = {
  state: "orphaned";
  reason: string;
  events?: DeckEvent[];
  orphanIdentity?: RunnerGroupIdentity;
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
  | { state: AcpOrphanedSession["state"]; reason: string }
  | AcpInactiveSession;

const registryKey = Symbol.for("inkie-deck.acp.registry");
const closingAlsKey = Symbol.for("inkie-deck.dev.server-closing-als");
const globals = globalThis as typeof globalThis & {
  [registryKey]?: {
    sessions: Map<string, AcpActiveSession | AcpCleanupSession | AcpOrphanedSession | AcpInactiveSession>;
    closing: boolean;
    shutdownInFlight: number;
    shutdownPromise?: Promise<void>;
    recoveryFailed: false | symbol;
  };
  [closingAlsKey]?: AsyncLocalStorage<() => boolean>;
};
const shared: NonNullable<(typeof globals)[typeof registryKey]> = globals[registryKey] ??= {
  sessions: new Map(),
  closing: false,
  shutdownInFlight: 0,
  shutdownPromise: undefined,
  recoveryFailed: false,
};
if (typeof shared.shutdownInFlight !== "number") shared.shutdownInFlight = 0;

function isRequestServerClosing(): boolean {
  return globals[closingAlsKey]?.getStore()?.() === true;
}

function isShuttingDown(): boolean {
  return shared.closing || shared.shutdownInFlight > 0 || isRequestServerClosing();
}

function executableKey(manifest: AcpAdapterManifest, id: ExecutableIdentity): string {
  return `${manifest.name}:${id.dev}:${id.ino}:${id.size}:${id.mtimeMs}:${id.sha256}`;
}

function codexFileIdentity(file: string) {
  const info = statSync(file);
  if (!info.isFile()) throw new Error("Codex executable is not a regular file.");
  // The native binary can be hundreds of megabytes, and canResume runs on polls.
  return [file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
}

function resolveBundledCodexFile(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier);
  } catch (error) {
    if (hasCode(error, "MODULE_NOT_FOUND")) return undefined;
    throw error;
  }
}

function codexNativeExecutable(launcher: string): string | undefined {
  const packageRoot = dirname(dirname(launcher));
  if (basename(launcher) !== "codex.js" || basename(packageRoot) !== "codex" ||
      basename(dirname(packageRoot)) !== "@openai") return undefined;
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== "linux" && platform !== "darwin") || (arch !== "x64" && arch !== "arm64")) return undefined;
  const target = `${arch === "x64" ? "x86_64" : "aarch64"}-${platform === "linux" ? "unknown-linux-musl" : "apple-darwin"}`;
  const packageFile = resolveBundledCodexFile(launcher, `@openai/codex-${platform}-${arch}/package.json`);
  const vendorRoot = join(packageFile ? dirname(packageFile) : packageRoot, "vendor");
  return resolveAcpExecutable(join(vendorRoot, target, "bin", "codex"));
}

function resumeEvidenceKey(
  manifest: AcpAdapterManifest,
  executable: string,
  identity: ExecutableIdentity,
  home: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const wrapperKey = executableKey(manifest, identity);
  if (manifest.runtime !== "codex") return wrapperKey;

  try {
    const childEnv = buildAcpSessionEnv({ environment: manifest.envAllowlist, envDefaults: manifest.envDefaults }, env);
    const override = childEnv.CODEX_PATH;
    let codexExecutable: string | undefined;
    if (override) {
      const command = override.includes("/") ? resolve(home, override) : override;
      codexExecutable = resolveAcpExecutable(command, childEnv);
    } else {
      codexExecutable = resolveBundledCodexFile(executable, "@openai/codex/bin/codex.js");
    }
    if (!codexExecutable) return undefined;
    const codexHome = resolve(home, childEnv.CODEX_HOME || join(childEnv.HOME || userInfo().homedir, ".codex"));
    let storeIdentity = [codexHome];
    try {
      const store = realpathSync(codexHome);
      const info = statSync(store, { bigint: true });
      if (!info.isDirectory()) return undefined;
      storeIdentity = [store, info.dev.toString(), info.ino.toString()];
    } catch (error) {
      if (!hasCode(error, "ENOENT") || childEnv.CODEX_HOME) throw error;
    }

    const codexIdentity = codexFileIdentity(codexExecutable);
    const nativeExecutable = codexNativeExecutable(codexExecutable);
    const nativeIdentity = nativeExecutable && codexFileIdentity(nativeExecutable);
    return `${manifest.name}:${createHash("sha256")
      .update(JSON.stringify([wrapperKey, override || null, codexIdentity, nativeIdentity, storeIdentity]))
      .digest("hex")}`;
  } catch {
    // A fresh start can proceed, but resume requires a verifiable identity.
    return undefined;
  }
}

function agentsRoot(env: NodeJS.ProcessEnv): string {
  return resolveAgentsRoot({ AGENTS_ROOT: env.AGENTS_HOME?.trim() || env.AGENTS_ROOT });
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

type ResumeEvidence = { supported: boolean; executableKey: string };
type Checkpoint = { sessionId: string; fileKey: string; evidence?: ResumeEvidence };
const MAX_CHECKPOINT_BYTES = 512;

// Device, inode and mtime are stable when the staged file is renamed.
function checkpointBinding(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
}

function readCheckpointFile(file: string): { text: string; fileKey: string; binding: string } | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.nlink > 1 || stat.size > MAX_CHECKPOINT_BYTES) return undefined;
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile() || fdStat.nlink > 1 || fdStat.size > MAX_CHECKPOINT_BYTES) return undefined;
      const buf = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const binding = checkpointBinding(fdStat);
      return {
        text: buf.subarray(0, n).toString("utf8").replace(/\r?\n$/, ""),
        fileKey: `${binding}:${fdStat.ctimeMs}`,
        binding,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[^ -~]/.test(value);
}

function parseResumeEvidence(text: string, checkpoint?: { fileKey: string; binding: string }): ResumeEvidence | undefined {
  try {
    const parsed = JSON.parse(text) as (Partial<ResumeEvidence> & { checkpointKey?: string }) | null;
    if (!parsed || typeof parsed.supported !== "boolean" || typeof parsed.executableKey !== "string") return undefined;
    if (checkpoint) {
      // Only the original Antigravity reader wrote evidence without a binding.
      if (parsed.checkpointKey === undefined) {
        return { supported: parsed.supported, executableKey: legacyAgyPrefix + parsed.executableKey };
      }
      if (parsed.checkpointKey !== checkpoint.binding && parsed.checkpointKey !== checkpoint.fileKey) return undefined;
    }
    return { supported: parsed.supported, executableKey: parsed.executableKey };
  } catch {
    return undefined;
  }
}

function rollbackExecutableKey(key: string): string {
  return key.startsWith(legacyAgyPrefix) ? key.slice(legacyAgyPrefix.length) : key;
}

function matchesResumeEvidence(evidence: ResumeEvidence, key: string | undefined): boolean {
  return key !== undefined && (evidence.executableKey === key || evidence.executableKey === rollbackExecutableKey(key));
}

function readStoredSession(home: string): Checkpoint | undefined {
  try {
    const file = literalSessionFile(home);
    const stored = readCheckpointFile(file);
    if (!stored) return undefined;
    // Keep reading the intermediate format that embedded evidence on line two.
    const [sessionId, evidenceLine, ...extra] = stored.text.split(/\r?\n/);
    if (!sessionId || !validSessionId(sessionId) || extra.length > 0) return undefined;
    let evidence: ResumeEvidence | undefined;
    if (evidenceLine !== undefined) {
      evidence = parseResumeEvidence(evidenceLine);
    } else {
      const sidecar = readCheckpointFile(join(dirname(file), capabilitiesName));
      if (sidecar) evidence = parseResumeEvidence(sidecar.text, stored);
    }
    return { sessionId, fileKey: stored.fileKey, evidence };
  } catch {
    return undefined;
  }
}

function clearStoredSessionId(home: string, expected: Checkpoint): void {
  try {
    if (readStoredSession(home)?.fileKey !== expected.fileKey) {
      return;
    }
    const file = literalSessionFile(home);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1) {
      unlinkSync(file);
    }
  } catch {
    // Best-effort cleanup of stale metadata.
  }
}

function stageCheckpointFile(tmp: string, bytes: Buffer): string {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(tmp, flags, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0 || offset + written > bytes.length) {
        throw new Error("Short write while persisting ACP session checkpoint");
      }
      offset += written;
    }
    const stat = fstatSync(fd);
    if (stat.size !== bytes.length) throw new Error("Truncated write while persisting ACP session checkpoint");
    return checkpointBinding(stat);
  } finally {
    closeSync(fd);
  }
}

/** Publish a checkpoint the original Antigravity reader can still load. */
function writeStoredCheckpoint(
  home: string,
  sessionId: string,
  evidence: ResumeEvidence,
  expected?: Checkpoint,
): void {
  if (!validSessionId(sessionId)) return;
  try {
    const file = literalSessionFile(home);
    const sidecar = join(dirname(file), capabilitiesName);
    const idStat = lstatSync(file, { throwIfNoEntry: false });
    const sidecarStat = lstatSync(sidecar, { throwIfNoEntry: false });
    if ((idStat && (!idStat.isFile() || idStat.nlink > 1)) ||
        (sidecarStat && (!sidecarStat.isFile() || sidecarStat.nlink > 1))) return;

    const suffix = randomUUID();
    const tmp = `${file}.tmp.${suffix}`;
    const tmpSidecar = `${sidecar}.tmp.${suffix}`;
    const previousSidecar = `${sidecar}.previous.${suffix}`;
    try {
      const checkpointKey = stageCheckpointFile(tmp, Buffer.from(sessionId + "\n", "utf8"));
      const bytes = Buffer.from(JSON.stringify({
        supported: evidence.supported,
        executableKey: rollbackExecutableKey(evidence.executableKey),
        checkpointKey,
      }) + "\n", "utf8");
      if (bytes.length > MAX_CHECKPOINT_BYTES) return;
      stageCheckpointFile(tmpSidecar, bytes);
      if (expected && readStoredSession(home)?.fileKey !== expected.fileKey) return;

      // Retire stale evidence before replacing the ID because older readers
      // do not check the binding. An interrupted publication fails closed.
      if (sidecarStat) renameSync(sidecar, previousSidecar);
      try {
        renameSync(tmp, file);
      } catch (error) {
        if (sidecarStat) renameSync(previousSidecar, sidecar);
        throw error;
      }
      renameSync(tmpSidecar, sidecar);
    } finally {
      for (const staged of [tmp, tmpSidecar, previousSidecar]) {
        try { unlinkSync(staged); } catch { /* ignore cleanup error */ }
      }
    }
  } catch {
    // Staging failures leave the previous checkpoint and evidence in place.
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
    env?: NodeJS.ProcessEnv;
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

  usageReading(agent: string): UsageReading {
    const session = this.session(agent);
    return readAcpUsageReading(this.env, agent, this.now(), session && "manifest" in session ? session : undefined);
  }

  canControl(agent: string): boolean {
    const session = this.session(agent);
    return (
      session !== undefined &&
      ("abortController" in session || session.state === "cleanup-pending" || session.state === "orphaned")
    );
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
   * Build event snapshot combining protected pending permissions + latest blocking card
   * with the retained event ring (used both while active AND on transition to stopped).
   */
  private snapshotEvents(entry: AcpActiveSession): DeckEvent[] {
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

  /**
   * Major 2 & 3: Return retained events plus protected pending permissions and latest blocking card.
   */
  events(agent: string): DeckEvent[] {
    const entry = this.session(agent);
    if (!entry) return [];
    if ("abortController" in entry) return this.snapshotEvents(entry);
    if ((entry.state === "stopped" || entry.state === "cleanup-pending" || entry.state === "orphaned") && entry.events) {
      return [...entry.events];
    }
    return [];
  }

  lastSessionId(agent: string): string | undefined {
    const home = agentHome(this.env, agent);
    return home ? readStoredSession(home)?.sessionId : undefined;
  }

  /**
   * Minor 1 (Round 11): Strictly positive, fail-closed capability gate for Resume.
   * Offer Resume ONLY when BOTH a valid saved checkpoint exists AND the currently installed
   * runtime identity has positively advertised resume/load support for the saved checkpoint.
   */
  canResume(agent: string): boolean {
    const home = agentHome(this.env, agent);
    if (!this.isOptedIn(agent) || !home) return false;
    const recorded = readStoredSession(home)?.evidence;
    if (!recorded?.supported) return false;
    try {
      const manifest = this.options.manifest ?? resolveAcpManifestForAgent(this.env, agent);
      if (!manifest) return false;
      const currentExec = resolveAcpExecutable(manifest.executableName, this.env, home);
      return matchesResumeEvidence(recorded, resumeEvidenceKey(manifest, currentExec, statExecutableIdentity(currentExec), home, this.env));
    } catch {
      return false;
    }
  }

  /**
   * Major 2 (Round 9): Clear the permanent closing latch ONLY when a fresh Vite server instance configures.
   */
  reopen(): void {
    if (shared.shutdownInFlight === 0) {
      shared.closing = false;
    }
  }

  status(agent: string): AcpSessionStatus | undefined {
    const session = this.session(agent);
    if (!session) return undefined;
    if (session.state === "cleanup-pending") return { state: session.state };
    if (session.state === "orphaned") return { state: session.state, reason: session.reason };
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
    if (isShuttingDown()) throw new StartRefusal("shutting-down");
    const home = this.isOptedIn(agent) ? agentHome(this.env, agent) : undefined;
    if (!home) throw new StartRefusal("not-opted-in");

    const existing = shared.sessions.get(home);
    if (existing && "abortController" in existing) throw new StartRefusal("busy");
    if (existing?.state === "cleanup-pending" || existing?.state === "orphaned") {
      throw new StartRefusal("locked");
    }

    if (process.platform !== "linux") {
      const reason = "The ACP runner requires Linux (/proc and flock).";
      shared.sessions.set(home, { state: "unavailable", reason });
      throw new LaunchFailure("unavailable", reason);
    }

    // Fail fast on explicit resume with no valid saved checkpoint (never fall back to session/new)
    if (options.resume && !readStoredSession(home)) {
      throw new LaunchFailure("start-failed", "No valid saved session checkpoint to resume.");
    }

    const priorEntry = shared.sessions.get(home);
    const manifest = this.options.manifest ?? resolveAcpManifestForAgent(this.env, agent);
    if (!manifest) throw new StartRefusal("not-opted-in");
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
      // A resumed generation rebuilds its transcript from replay in a fresh event list and journal.
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
        if (abortController.signal.aborted || isShuttingDown()) {
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
        if (abortController.signal.aborted || isShuttingDown()) {
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
        displayName: manifest.displayName,
        allowMismatch: this.options.allowVersionMismatch,
        cwd: home,
        env: this.env,
        extraEnvAllowlist: manifest.envAllowlist,
        signal: abortController.signal,
        exec: this.options.execVersion,
      });
      detectedVersion = versionInfo.version;
      if (abortController.signal.aborted || isShuttingDown()) {
        clearReservation();
        throw new StartRefusal("shutting-down");
      }
      if (!this.isOptedIn(agent) || (!this.options.manifest && resolveAcpManifestForAgent(this.env, agent) !== manifest)) {
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
        if (abortController.signal.aborted || isShuttingDown()) {
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

    // Re-verify opt-in, tmux window absence, locked resume checkpoint, and pinned executable identity AFTER lock claim
    let resumeCheckpoint: Checkpoint | undefined;
    const launchEnv = { ...this.env };
    let adapterKey: string | undefined;
    try {
      if (!this.isOptedIn(agent) || (!this.options.manifest && resolveAcpManifestForAgent(this.env, agent) !== manifest)) {
        throw new StartRefusal("not-opted-in");
      }
      this.assertNoTmuxWindow(agent);
      adapterKey = resumeEvidenceKey(manifest, executable, execIdentity, home, launchEnv);
      if (options.resume) {
        resumeCheckpoint = readStoredSession(home);
        if (!resumeCheckpoint) {
          throw new LaunchFailure("start-failed", "No valid saved session checkpoint to resume.");
        }
        const recorded = resumeCheckpoint.evidence;
        if (!recorded?.supported || !matchesResumeEvidence(recorded, adapterKey)) {
          throw new LaunchFailure(
            "start-failed",
            "Saved session checkpoint cannot be resumed with this runtime, executable or session store.",
          );
        }
      }
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

    activeSession.codexQuotaContext = acpQuotaContext(manifest, launchEnv, home);
    const adapter: AcpAdapter = {
      executable,
      args: manifest.args,
      version: detectedVersion || manifest.semverFloor,
      environment: manifest.envAllowlist,
      knownExtensions: manifest.knownExtensions,
      displayName: manifest.displayName,
      authHint: manifest.authHint,
      envDefaults: manifest.envDefaults,
      readUsage: () => readAcpUsageReading(this.env, agent, this.now(), activeSession),
    };

    const sessionOptions = {
      cwd: home,
      dataRoot: this.options.dataRoot ?? home,
      env: launchEnv,
      sessionMarker: sessionId,
      resumeSessionId: resumeCheckpoint?.sessionId,
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
    const terminal = terminalKind === "unsupported" || terminalKind === "failed" || terminalKind === "disconnected";
    if (terminal && session.resumeRejected && resumeCheckpoint) {
      clearStoredSessionId(home, resumeCheckpoint);
    }
    if (session.negotiated && !session.supportsResume?.()) {
      const checkpoint = readStoredSession(home);
      if (adapterKey && checkpoint?.evidence?.supported && matchesResumeEvidence(checkpoint.evidence, adapterKey)) {
        writeStoredCheckpoint(home, checkpoint.sessionId, { executableKey: adapterKey, supported: false }, checkpoint);
      }
    }
    if (terminal) {
      await session.close().catch(() => {});
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      if (terminalKind === "unsupported") {
        throw new LaunchFailure("unavailable", session.unsupportedReason ?? "Agent does not support the required ACP protocol version or capability.");
      }
      throw new LaunchFailure("start-failed", `ACP session negotiation ended in state '${terminalKind}'.`);
    }

    if (abortController.signal.aborted || isShuttingDown()) {
      await session.close().catch(() => {});
      await this.cleanupFailedStart(home, activeSession, lock);
      resolveSettled();
      throw new StartRefusal("shutting-down");
    }

    activeSession.state = "running";
    // Major 2: Persist .acp-last-session ONLY when agent advertised resume/load capability.
    // Never delete a previously saved valid checkpoint on a fresh Start with a downgraded binary;
    // checkpoints are cleared ONLY on explicit session-not-found for that exact ID.
    if (session.activeSessionId && adapterKey && session.supportsResume?.()) {
      writeStoredCheckpoint(home, session.activeSessionId, { supported: true, executableKey: adapterKey });
    }

    activeSession.abandonOnUnkillable = () => {
      const retainedEvents = this.snapshotEvents(activeSession);
      this.abandonCleanup(home, activeSession, lock, retainedEvents);
    };
    const exitSettled = this.recordExit(home, activeSession, lock).finally(() => resolveSettled());
    activeSession.settled = exitSettled;
    void exitSettled.catch(() => {});

    return session;
  }

  private assertNoTmuxWindow(agent: string): void {
    let windows: string[];
    try {
      const list = this.options.listWindows ?? listTmuxWindows;
      const baseEnv: NodeJS.ProcessEnv = { ...this.env, MC_TMUX_SESSION: "agents" };
      delete baseEnv.TMUX;
      delete baseEnv.TMUX_PANE;
      delete baseEnv.TMUX_TMPDIR;
      windows = list(baseEnv, true);
    } catch {
      throw new StartRefusal("tmux-unknown");
    }
    if (windows.includes(agent)) throw new StartRefusal("tmux-active");
  }

  private abandonCleanup(
    home: string,
    activeSession: AcpActiveSession,
    lock: ReturnType<typeof claimRunnerLock>,
    retainedEvents: DeckEvent[],
  ): void {
    // Major 3 (Round 12): Verify birth/session-marker ownership BEFORE signaling, preserve orphanIdentity,
    // and ALWAYS close the lock descriptor (lock.retain()) and transition to 'orphaned' in finally
    // even if signaling throws EPERM.
    const id = lock.identity();
    const pid = id.pid > 0 ? id.pid : (activeSession.session?.pid ?? activeSession.pid);
    const orphanIdentity: RunnerGroupIdentity | undefined = pid > 0
      ? { pid, birth: id.birth, sessionId: id.sessionId }
      : undefined;
    try {
      if (orphanIdentity && orphanIdentity.birth) {
        killVerifiedRunnerGroup(orphanIdentity);
      }
    } catch {
      // Never let EPERM or /proc errors skip lock.retain() or the orphaned transition.
    } finally {
      try {
        lock.retain();
      } catch {
        // ignore
      }
      shared.sessions.set(home, {
        state: "orphaned",
        reason: "Runner lock cleanup failed during shutdown; orphaned lock requires recovery.",
        events: retainedEvents,
        orphanIdentity,
      });
    }
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
    const retainedEvents = this.snapshotEvents(activeSession);
    try {
      await lock.release();
      if (shared.sessions.get(home) === activeSession) {
        shared.sessions.set(home, {
          state: "stopped",
          code: activeSession.session?.exitInfo.code ?? null,
          signal: activeSession.session?.exitInfo.signal ?? null,
          exitedAt: this.now(),
          events: retainedEvents,
        });
      }
    } catch {
      let pending: Promise<void> | undefined;
      const cleanup: AcpCleanupSession = {
        state: "cleanup-pending",
        events: retainedEvents,
        retry: () => pending ??= (async () => {
          await lock.release();
          shared.sessions.set(home, {
            state: "stopped",
            code: activeSession.session?.exitInfo.code ?? null,
            signal: activeSession.session?.exitInfo.signal ?? null,
            exitedAt: this.now(),
            events: retainedEvents,
          });
        })().finally(() => { pending = undefined; }),
        abandon: () => this.abandonCleanup(home, activeSession, lock, retainedEvents),
      };
      shared.sessions.set(home, cleanup);
    }
  }

  private claimLock(home: string, sessionId: string) {
    try {
      return claimRunnerLock(join(home, lockName), sessionId, this.now(), "acp");
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
    if (shared.sessions.get(home) !== activeSession) return;

    const exitInfo = activeSession.session?.exitInfo ?? { code: null, signal: null };
    const exitedAt = this.now();
    // Major 3: Snapshot protected blocking cards + retained events so disconnect never drops latest blocker
    const retainedEvents = this.snapshotEvents(activeSession);
    let pending: Promise<void> | undefined;
    const cleanup: AcpCleanupSession = {
      state: "cleanup-pending",
      events: retainedEvents,
      retry: () => pending ??= lock.release().then(() => {
        shared.sessions.set(home, {
          state: "stopped",
          code: exitInfo.code,
          signal: exitInfo.signal,
          exitedAt,
          events: retainedEvents,
        });
      }).finally(() => { pending = undefined; }),
      abandon: () => this.abandonCleanup(home, activeSession, lock, retainedEvents),
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
      // Major 6 (Round 14) & Major 7 (Round 16): ALWAYS bound the settled wait after session.close()
      // (both on EPERM unkillable child AND when a helper outside the process group keeps inherited
      // stdout open preventing Node's 'close' event). Transition cleanly via abandonOnUnkillable so
      // Stop and shutdown NEVER hang indefinitely.
      if (activeSession.session) {
        const settledInTime = await Promise.race([
          activeSession.settled.then(() => true, () => true),
          delay(150).then(() => false),
        ]);
        if (!settledInTime) {
          activeSession.abandonOnUnkillable?.();
          return;
        }
      }
      await activeSession.settled.catch(() => {});
    })();
    return activeSession.stopPromise;
  }

  async shutdown(options: { permanent?: boolean; cleanupRetryDelayMs?: number } = {}): Promise<void> {
    if (options.permanent !== false) {
      shared.closing = true;
    }
    const retryDelayMs = options.cleanupRetryDelayMs ?? SHUTDOWN_CLEANUP_RETRY_DELAY_MS;
    shared.shutdownInFlight += 1;
    const drain = async () => {
      // Phase 1: Stop all active sessions (starting, running, stopping).
      const active = Array.from(shared.sessions.values()).filter(
        (session): session is AcpActiveSession => "abortController" in session,
      );
      if (active.length > 0) {
        await Promise.all(active.map((session) => this.stopSession(session).catch(() => {})));
      }

      // Phase 2 (Major 4, Round 10): Bounded cleanup retries with delay so a persistent lock failure
      // (e.g. replaced lock inode) NEVER loops infinitely or hangs production/Vite shutdown.
      for (let attempt = 1; attempt <= MAX_SHUTDOWN_CLEANUP_ATTEMPTS; attempt++) {
        const pendingEntries = Array.from(shared.sessions.entries()).filter(
          (entry): entry is [string, AcpCleanupSession] => entry[1].state === "cleanup-pending",
        );
        if (pendingEntries.length === 0) break;

        let anyRetryableFailure = false;
        await Promise.all(
          pendingEntries.map(async ([home, session]) => {
            try {
              await session.retry();
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              const nonRetryable = msg.includes("changed owners");
              if (nonRetryable || attempt === MAX_SHUTDOWN_CLEANUP_ATTEMPTS) {
                // Major 4 (Round 11): Kill process group, close lock fd, and transition to 'orphaned'
                // which blocks admission for that home until recovered.
                session.abandon();
              } else {
                anyRetryableFailure = true;
              }
            }
          }),
        );
        if (!anyRetryableFailure) break;
        if (attempt < MAX_SHUTDOWN_CLEANUP_ATTEMPTS && retryDelayMs > 0) {
          await delay(retryDelayMs);
        }
      }
    };
    const inFlight = (shared.shutdownPromise ??= drain().finally(() => {
      shared.shutdownPromise = undefined;
    }));
    try {
      await inFlight;
    } finally {
      shared.shutdownInFlight = Math.max(0, shared.shutdownInFlight - 1);
    }
  }

  private async recoverHome(home: string): Promise<void> {
    const existing = shared.sessions.get(home);
    if (existing && ("abortController" in existing || existing.state === "cleanup-pending")) return;

    // Major 3 (Round 12): If this home has an abandoned orphan with a recorded process identity,
    // verify/reap that process group FIRST and NEVER clear 'orphaned' while the group is live or
    // unverifiable, even if .runner.lock is absent.
    if (existing?.state === "orphaned" && existing.orphanIdentity) {
      let groupState = killVerifiedRunnerGroup(existing.orphanIdentity);
      if (groupState === "alive") {
        for (let attempt = 0; attempt < 25 && groupState === "alive"; attempt++) {
          await delay(20);
          groupState = isRunnerGroupVerifiedAlive(existing.orphanIdentity);
        }
      }
      if (groupState !== "dead") {
        return;
      }
    }

    const lockFile = join(home, lockName);
    const expectedOwner = homeWantsAcp(home) ? undefined : "acp";
    try {
      const result = await recoverRunnerLock(lockFile, expectedOwner);
      if (shared.sessions.get(home) !== existing) return;
      if (result === "recovered") {
        shared.sessions.set(home, { state: "stopped", code: null, exitedAt: this.now() });
      } else if (result === "absent" && (existing?.state === "locked" || existing?.state === "orphaned")) {
        shared.sessions.delete(home);
      }
    } catch {
      if (expectedOwner && readRunnerLockOwner(lockFile) !== expectedOwner) return;
      if (shared.sessions.get(home) === existing) {
        if (existing?.state === "orphaned") return;
        shared.sessions.set(home, { state: "locked", reason: "Could not safely recover the runner lock." });
      }
    }
  }

  async recoverAgent(agent: string): Promise<void> {
    if (process.platform !== "linux") return;
    const home = agentHome(this.env, agent);
    if (!home) return;
    await this.recoverHome(home);
  }

  async recover(): Promise<void> {
    if (process.platform !== "linux") return;
    const previousFailure = shared.recoveryFailed;
    const homesToRecover = new Set<string>();
    for (const [trackedHome, entry] of shared.sessions.entries()) {
      // Minor 1 (Round 13): Always include tracked orphaned/locked homes even if they opted out of .runner=acp
      if (entry.state === "orphaned" || entry.state === "locked") {
        homesToRecover.add(trackedHome);
      }
    }
    try {
      const root = realpathSync(agentsRoot(this.env));
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !AGENT_NAME_RE.test(entry.name)) continue;
        const home = join(root, entry.name);
        // An ACP lock can survive a crash even if the operator has since opted out.
        if (!homeWantsAcp(home) && readRunnerLockOwner(join(home, lockName)) !== "acp") continue;
        homesToRecover.add(home);
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) shared.recoveryFailed = Symbol();
    }
    for (const home of homesToRecover) {
      await this.recoverHome(home);
    }
    if (shared.recoveryFailed === previousFailure) shared.recoveryFailed = false;
  }
}

export const acpRunnerRegistry = new AcpRunnerRegistry();
