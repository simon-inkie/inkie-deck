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

import {
  compareSemver, parseSemver, resolveAcpManifest, sanitizePathEnv,
  type AcpAdapterManifest, type ExecutableIdentity,
} from "./acp-manifest";

const BASE_PROBE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const;
const EXPLICIT_DECK_VARS = new Set(["INBOX_ROOT", "DATA_ROOT", "GOOGLE_GENERATIVE_AI_API_KEY"]);
const DECK_VAR_RE = /^(?:MC_|DECK_|INKIE_|DEEPGRAM_)/i;
const MAX_PROBE_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

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
  displayName?: string;
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
    error?: NodeJS.ErrnoException;
  };
}

function evaluateVersionOutput(
  rawOutput: string,
  semverFloor: string,
  allowMismatch: boolean,
  displayName = "Antigravity",
): { version: string; ok: boolean } {
  const firstLine = rawOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (!firstLine) {
    if (allowMismatch) return { version: "unknown", ok: false };
    throw new LaunchFailure("unavailable", `${displayName} version probe returned empty stdout.`);
  }
  const parts = firstLine.split(/\s+/);
  const version = parts.length === 2 ? parts[1]! : firstLine;
  const semver = parseSemver(version);
  if (!semver) {
    if (allowMismatch) {
      return { version: firstLine, ok: false };
    }
    throw new LaunchFailure("unavailable", `Failed to parse ${displayName} version output.`);
  }

  const parsedFloor = parseSemver(semverFloor);
  if (!parsedFloor) {
    throw new Error(`Invalid semver floor configuration: '${semverFloor}'`);
  }

  const cmp = compareSemver(version, semverFloor);
  const ok = cmp >= 0;
  if (!ok && !allowMismatch) {
    throw new LaunchFailure(
      "unavailable",
      `${displayName} version ${version} does not meet required semver floor ${semverFloor}.`,
    );
  }

  return { version, ok };
}

function versionProbeFailure(displayName: string, error: unknown): LaunchFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : "";
  return new LaunchFailure("unavailable", `Could not verify ${displayName} version${detail}.`, error);
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
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
  });

  let rawOutput = "";
  try {
    const res = runner(executable, ["--version"], { cwd: options.cwd, env: probeEnv });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`Version probe exited with status ${res.status ?? "null"}.`);
    }
    rawOutput = res.stdout.slice(0, MAX_PROBE_BYTES).trim();
  } catch (err) {
    if (options.allowMismatch) {
      return { version: "unknown", ok: false };
    }
    throw versionProbeFailure(options.displayName ?? "Antigravity", err);
  }

  return evaluateVersionOutput(rawOutput, semverFloor, Boolean(options.allowMismatch), options.displayName);
}

export async function probeAgyVersion(
  executable: string,
  semverFloor: string,
  options: VersionProbeOptions = {},
): Promise<{ version: string; ok: boolean }> {
  if (options.signal?.aborted) {
    throw new LaunchFailure("start-failed", `${options.displayName ?? "Antigravity"} version probe aborted.`);
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
      finish(new Error(`${options.displayName ?? "Antigravity"} version probe aborted.`));
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
      finish(new Error(`${options.displayName ?? "Antigravity"} version probe timed out.`));
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
      throw new LaunchFailure("start-failed", `${options.displayName ?? "Antigravity"} version probe aborted.`, err);
    }
    if (options.allowMismatch) return null;
    throw versionProbeFailure(options.displayName ?? "Antigravity", err);
  });

  if (rawOutput === null) {
    return { version: "unknown", ok: false };
  }
  return evaluateVersionOutput(rawOutput, semverFloor, Boolean(options.allowMismatch), options.displayName);
}

function agentsRoot(env: NodeJS.ProcessEnv): string {
  return resolveAgentsRoot({ AGENTS_ROOT: env.AGENTS_HOME?.trim() || env.AGENTS_ROOT });
}

export function resolveAcpAgentHome(env: NodeJS.ProcessEnv, agent: string): string | undefined {
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

export function resolveAcpManifestForAgent(env: NodeJS.ProcessEnv, agent: string): AcpAdapterManifest | undefined {
  const home = resolveAcpAgentHome(env, agent);
  if (!home) return undefined;
  try {
    if (readAgentFile(join(home, ".runner")) !== "acp") return undefined;
    return resolveAcpManifest(readAgentFile(join(home, ".runtime")));
  } catch {
    return undefined;
  }
}

export function isAcpOptedIn(env: NodeJS.ProcessEnv, agent: string): boolean {
  return acpRunnerEnabled(env) && resolveAcpManifestForAgent(env, agent) !== undefined;
}
