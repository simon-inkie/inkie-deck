import { isAbsolute } from "node:path";

export type UsageState = "ok" | "low" | "exhausted" | "unknown";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
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
  runtime: string;
  displayName: string;
  authHint: string;
  usageKind: "antigravity" | "codex";
  envDefaults?: Readonly<Record<string, string>>;
  runner: "acp";
  executableName: string;
  args: readonly string[];
  semverFloor: string;
  envAllowlist: readonly string[];
  knownExtensions: readonly string[];
}

export const antigravity1Manifest: AcpAdapterManifest = {
  name: "antigravity-1",
  runtime: "agy",
  displayName: "Antigravity",
  authHint: "Sign in with `agy acp --login` in a terminal.",
  usageKind: "antigravity",
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

export const codexAcp1Manifest: AcpAdapterManifest = {
  name: "codex-acp-1",
  runtime: "codex",
  runner: "acp",
  executableName: "codex-acp",
  args: [],
  semverFloor: "2.6.0",
  envAllowlist: ["CODEX_HOME", "CODEX_PATH", "NO_BROWSER"],
  envDefaults: { NO_BROWSER: "1" },
  knownExtensions: [],
  displayName: "Codex ACP",
  authHint: "Sign in with `codex login` in a terminal.",
  usageKind: "codex",
};

export function resolveAcpManifest(runtime: string | undefined): AcpAdapterManifest | undefined {
  switch (runtime) {
    case "agy": return antigravity1Manifest;
    case "codex": return codexAcp1Manifest;
    default: return undefined;
  }
}

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

// Compatibility exports: filesystem access and executable probing live on the server.
export {
  buildConstrainedProbeEnv, checkAgyVersion, isAcpOptedIn, probeAgyVersion,
  resolveAcpExecutable, resolveAcpManifestForAgent, statExecutableIdentity,
} from "./acp-manifest.server";
export type { VersionProbeOptions } from "./acp-manifest.server";
