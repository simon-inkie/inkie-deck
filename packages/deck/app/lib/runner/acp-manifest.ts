import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveAgentsRoot } from "../agent-model.server.js";
import { acpRunnerEnabled } from "../instance.server.js";
import { AGENT_NAME_RE } from "../safe-fs.server.js";
import { LaunchFailure } from "./runner.js";

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

export interface UnknownExtensionRecord {
  v: 1;
  ts: string;
  session?: string;
  extensionName: string;
  method: string;
  params: unknown;
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

export function parseSemver(versionStr: string): { major: number; minor: number; patch: number } | null {
  const match = versionStr.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

export function compareSemver(v1: string, v2: string): number {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (!p1 || !p2) throw new Error(`Invalid semver string: '${v1}' or '${v2}'`);
  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;
  return 0;
}

export function resolveAcpExecutable(executableName: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  if (!executableName) throw new LaunchFailure("start-failed", "Executable name is required.");
  if (isAbsolute(executableName)) {
    try {
      accessSync(executableName, constants.X_OK);
      if (statSync(executableName).isFile()) return executableName;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    throw new LaunchFailure("unavailable", `Configured executable '${executableName}' is not executable.`);
  }

  const baseDir = cwd ?? process.cwd();
  const searchPath = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":");
  for (const dir of searchPath) {
    if (!dir) continue;
    const candidate = resolve(baseDir, dir, executableName);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }

  throw new LaunchFailure("unavailable", `Executable '${executableName}' not found in PATH.`);
}

export function checkAgyVersion(
  executable: string,
  semverFloor: string,
  options: {
    allowMismatch?: boolean;
    exec?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  } = {},
): { version: string; ok: boolean } {
  const runner = options.exec ?? ((cmd: string, args: string[]) => {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  });

  let rawOutput = "";
  try {
    const res = runner(executable, ["--version"]);
    if (res.status !== 0) {
      throw new Error(`Command exited with status ${res.status}: ${res.stderr.trim()}`);
    }
    rawOutput = res.stdout.trim();
  } catch (err) {
    if (options.allowMismatch) {
      return { version: "unknown", ok: true };
    }
    throw new LaunchFailure("unavailable", `Could not verify Antigravity version: ${String(err)}`, err);
  }

  const firstLine = rawOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const semver = parseSemver(firstLine);
  if (!semver) {
    if (options.allowMismatch) {
      return { version: firstLine || "unknown", ok: true };
    }
    throw new LaunchFailure("unavailable", `Failed to parse Antigravity version output: '${firstLine}'`);
  }

  const parsedFloor = parseSemver(semverFloor);
  if (!parsedFloor) {
    throw new Error(`Invalid semver floor configuration: '${semverFloor}'`);
  }

  const cmp = compareSemver(firstLine, semverFloor);
  const ok = cmp >= 0;
  if (!ok && !options.allowMismatch) {
    throw new LaunchFailure(
      "unavailable",
      `Antigravity version ${firstLine} does not meet required semver floor ${semverFloor}.`,
    );
  }

  return { version: firstLine, ok };
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
