import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveAgentsRoot } from "../agent-model.server.js";
import { acpRunnerEnabled } from "../instance.server.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import { LaunchFailure, signalGroup } from "./runner.js";

export type UsageState = "ok" | "low" | "exhausted" | "unknown";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string;
}

export interface UsageReading {
  state: UsageState;
  windows?: UsageWindow[];
  source: string;
  readAt: string;
}

export function antigravityUsageReading(now = () => new Date().toISOString()): UsageReading {
  return {
    state: "unknown",
    source: "antigravity",
    readAt: now(),
  };
}

export type ExtensionClassification = "non-blocking" | "blocking" | "fatal";

export interface UnknownExtensionRecord {
  v: 1;
  ts: string;
  session: string | null;
  extensionName: string;
  method: string;
  classification: ExtensionClassification;
  paramsSummary: string | null;
}

export interface AcpAdapterManifest {
  name: string;
  runner: "acp";
  executableName: string;
  args: readonly string[];
  semverFloor: string;
  envAllowlist: readonly string[];
  knownExtensions: readonly string[];
}

export const antigravity1Manifest: AcpAdapterManifest = {
  name: "antigravity-1",
  runner: "acp",
  executableName: "agy",
  args: ["acp"],
  semverFloor: "1.5.0",
  envAllowlist: [],
  knownExtensions: [
    "antigravity/heartbeat",
    "antigravity/ping",
  ],
};

const BASE_PROBE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const;
const EXPLICIT_DECK_VARS = new Set(["INBOX_ROOT", "DATA_ROOT", "GOOGLE_GENERATIVE_AI_API_KEY"]);
const DECK_VAR_RE = /^(?:MC_|DECK_|INKIE_|DEEPGRAM_)/i;
const MAX_PROBE_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export function sanitizePathEnv(rawPath?: string): string {
  const parts = (rawPath ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":")
    .filter((dir) => dir.length > 0 && isAbsolute(dir));
  return parts.length > 0 ? parts.join(":") : "/usr/local/bin:/usr/bin:/bin";
}

export interface ExecutableIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export function statExecutableIdentity(executablePath: string): ExecutableIdentity {
  const fd = openSync(executablePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new LaunchFailure("unavailable", `Pinned executable '${executablePath}' is not a regular file.`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n <= 0) break;
      hash.update(n === chunk.length ? chunk : chunk.subarray(0, n));
      offset += n;
    }
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

export function buildConstrainedProbeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  extraAllowlist: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const key of [...BASE_PROBE_ENV_KEYS, ...extraAllowlist]) {
    if (DECK_VAR_RE.test(key) || EXPLICIT_DECK_VARS.has(key)) continue;
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = key === "PATH" ? sanitizePathEnv(value) : value;
    }
  }
  return env;
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(versionStr: string): ParsedSemver | null {
  const trimmed = versionStr.trim();
  const match = trimmed.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const id of prerelease) {
    if (/^0\d+$/.test(id)) return null;
  }
  return { major, minor, patch, prerelease };
}

export function compareSemver(v1: string, v2: string): number {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (!p1 || !p2) throw new Error(`Invalid semver string: '${v1}' or '${v2}'`);
  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;
  if (p1.prerelease.length === 0 && p2.prerelease.length === 0) return 0;
  if (p1.prerelease.length === 0) return 1;
  if (p2.prerelease.length === 0) return -1;
  const len = Math.max(p1.prerelease.length, p2.prerelease.length);
  for (let i = 0; i < len; i++) {
    const a = p1.prerelease[i];
    const b = p2.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) > Number(b) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function isInsideDir(target: string, dir: string): boolean {
  try {
    const resolvedDir = realpathSync(dir);
    const rel = relative(resolvedDir, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function verifyPinnedExecutable(candidate: string, rejectInsideDir?: string): string | null {
  try {
    const linkStat = lstatSync(candidate);
    if (linkStat.isSymbolicLink()) {
      const target = realpathSync(candidate);
      if (rejectInsideDir && isInsideDir(target, rejectInsideDir)) return null;
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) return null;
      accessSync(target, constants.X_OK);
      return target;
    }
    if (!linkStat.isFile()) return null;
    const target = realpathSync(candidate);
    if (rejectInsideDir && isInsideDir(target, rejectInsideDir)) return null;
    accessSync(target, constants.X_OK);
    return target;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    return null;
  }
}

export function resolveAcpExecutable(
  executableName: string,
  env: NodeJS.ProcessEnv = process.env,
  agentHomeDir?: string,
): string {
  if (!executableName) throw new LaunchFailure("start-failed", "Executable name is required.");
  if (isAbsolute(executableName)) {
    const pinned = verifyPinnedExecutable(executableName);
    if (pinned) return pinned;
    throw new LaunchFailure("unavailable", `Configured executable '${executableName}' is not executable.`);
  }
  if (executableName.includes("/") || executableName.includes("\\")) {
    throw new LaunchFailure("start-failed", "Relative executable paths are not allowed.");
  }

  const searchPath = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":");
  for (const dir of searchPath) {
    // Reject empty and relative PATH entries (such as '.' or 'bin') so lookup never resolves against cwd/agent home.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = resolve(dir, executableName);
    const pinned = verifyPinnedExecutable(candidate, agentHomeDir);
    if (pinned) return pinned;
  }

  throw new LaunchFailure("unavailable", `Executable '${executableName}' not found in trusted PATH.`);
}

export interface VersionProbeOptions {
  allowMismatch?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraEnvAllowlist?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  exec?: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

function evaluateVersionOutput(
  rawOutput: string,
  semverFloor: string,
  allowMismatch: boolean,
): { version: string; ok: boolean } {
  const firstLine = rawOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const semver = parseSemver(firstLine);
  if (!semver) {
    if (allowMismatch) {
      return { version: firstLine || "unknown", ok: false };
    }
    throw new LaunchFailure("unavailable", "Failed to parse Antigravity version output.");
  }

  const parsedFloor = parseSemver(semverFloor);
  if (!parsedFloor) {
    throw new Error(`Invalid semver floor configuration: '${semverFloor}'`);
  }

  const cmp = compareSemver(firstLine, semverFloor);
  const ok = cmp >= 0;
  if (!ok && !allowMismatch) {
    throw new LaunchFailure(
      "unavailable",
      `Antigravity version ${firstLine} does not meet required semver floor ${semverFloor}.`,
    );
  }

  return { version: firstLine, ok };
}

export function checkAgyVersion(
  executable: string,
  semverFloor: string,
  options: VersionProbeOptions = {},
): { version: string; ok: boolean } {
  const probeEnv = buildConstrainedProbeEnv(options.env ?? process.env, options.extraEnvAllowlist);
  const runner = options.exec ?? ((cmd: string, args: string[]) => {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_BYTES,
      killSignal: "SIGKILL",
      cwd: options.cwd,
      env: probeEnv,
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  });

  let rawOutput = "";
  try {
    const res = runner(executable, ["--version"], { cwd: options.cwd, env: probeEnv });
    if (res.status !== 0) {
      throw new Error(`Version probe exited with status ${res.status ?? "null"}.`);
    }
    rawOutput = res.stdout.slice(0, MAX_PROBE_BYTES).trim();
  } catch (err) {
    if (options.allowMismatch) {
      return { version: "unknown", ok: false };
    }
    throw new LaunchFailure("unavailable", "Could not verify Antigravity version.", err);
  }

  return evaluateVersionOutput(rawOutput, semverFloor, Boolean(options.allowMismatch));
}

export async function probeAgyVersion(
  executable: string,
  semverFloor: string,
  options: VersionProbeOptions = {},
): Promise<{ version: string; ok: boolean }> {
  if (options.signal?.aborted) {
    throw new LaunchFailure("start-failed", "Antigravity version probe aborted.");
  }
  if (options.exec) {
    return checkAgyVersion(executable, semverFloor, options);
  }
  const probeEnv = buildConstrainedProbeEnv(options.env ?? process.env, options.extraEnvAllowlist);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const rawOutput = await new Promise<string>((resolveOut, rejectOut) => {
    const child = spawn(executable, ["--version"], {
      cwd: options.cwd,
      env: probeEnv,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    let groupCleaned = false;
    const cleanupGroup = () => {
      if (groupCleaned) return;
      groupCleaned = true;
      if (child.pid) signalGroup(child.pid, "SIGKILL");
    };
    const onAbort = () => {
      cleanupGroup();
      finish(new Error("Antigravity version probe aborted."));
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      cleanupGroup();
      if (err) rejectOut(err);
      else resolveOut(stdout.trim());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      cleanupGroup();
      finish(new Error("Antigravity version probe timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_BYTES) {
        stdout += chunk.toString("utf8").slice(0, MAX_PROBE_BYTES - stdout.length);
      }
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      cleanupGroup();
      if (code !== 0) finish(new Error(`Version probe exited with status ${code ?? "null"}.`));
      else finish();
    });
  }).catch((err) => {
    if (options.signal?.aborted) {
      throw new LaunchFailure("start-failed", "Antigravity version probe aborted.", err);
    }
    if (options.allowMismatch) return null;
    throw new LaunchFailure("unavailable", "Could not verify Antigravity version.", err);
  });

  if (rawOutput === null) {
    return { version: "unknown", ok: false };
  }
  return evaluateVersionOutput(rawOutput, semverFloor, Boolean(options.allowMismatch));
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

export function isAcpOptedIn(env: NodeJS.ProcessEnv, agent: string): boolean {
  if (!acpRunnerEnabled(env)) return false;
  const home = agentHome(env, agent);
  if (!home) return false;
  try {
    if (readAgentFile(join(home, ".runner")) !== "acp") return false;
    const runtime = readAgentFile(join(home, ".runtime"));
    return runtime === undefined || runtime === "agy";
  } catch {
    return false;
  }
}
