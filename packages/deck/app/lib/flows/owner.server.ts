/**
 * owner.server.ts - Single-writer runner lock for Deck task flows.
 *
 * Implements process ownership via a dedicated SQLite exclusive lock on `flows.owner`.
 * Uses SQLite native locks (fcntl on POSIX, LockFileEx on Windows) which are
 * automatically released by the operating system kernel if the runner process terminates
 * or crashes (kill -9). Eliminates fragile PID inspection, boot ID, and birth-time takeover.
 *
 * Enforces:
 * - Exclusive locking via PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;
 * - In-process registry preventing multiple runners in the same process.
 * - Strict FlowIdRegex validation and confinement preventing traversal or symlink escape.
 * - Refusal to place private flow databases inside any git working tree.
 * - Fail-closed filesystem safety check rejecting WSL /mnt/<drive>, NFS, SMB/CIFS, 9p, virtiofs,
 *   or unreadable /proc/self/mountinfo on Linux.
 * - Explicit mode 0700 directory and 0600 lock file permissions.
 *
 * Threat Model (approved 23 Nov 2026):
 * Defends against crashes (SIGKILL / power loss), buggy callers, and accidental concurrent
 * processes of the same user (a second Deck instance or stray runner). Does NOT defend against
 * a malicious same-user process (which can already read and edit the user's data directory and
 * flows.db directly). Confinement, symlink/hardlink checks, held dirfds, and post-open inode
 * checks remain as defense-in-depth; adversarial same-user directory redirects between native
 * SQLite pathname resolution and open() are explicitly out of threat model.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { FlowIdRegex } from "./types.js";

export class RunnerLockBusyError extends Error {
  constructor(public readonly projectId: string, public readonly lockPath: string) {
    super(`Project flow execution is currently locked by another active runner: ${projectId} (${lockPath})`);
    this.name = "RunnerLockBusyError";
  }
}

export class UnsafeFilesystemError extends Error {
  constructor(public readonly targetPath: string, public readonly mountType: string) {
    super(`Refusing SQLite execution on unsafe filesystem '${mountType}': ${targetPath}`);
    this.name = "UnsafeFilesystemError";
  }
}

export class OwnerLockRequiredError extends Error {
  constructor(public readonly projectId: string) {
    super(`Writable FlowsStore requires an active OwnerLock for project '${projectId}'`);
    this.name = "OwnerLockRequiredError";
  }
}

// In-process registry to guard against multiple runners in the same Deck process
const inProcessLocks = new Map<string, Database.Database>();
// Non-forgeable capability table binding live OwnerLock instances to their canonical dir, held dirfd, and owner inode
const activeOwnerLockMeta = new WeakMap<
  OwnerLock,
  { realProjectDir: string; projectDirFd: number; ownerDev: number; ownerIno: number }
>();

const UNSAFE_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "9p",
  "v9fs",
  "virtiofs",
  "fuse.sshfs",
  "fuse.gvfsd-fuse",
]);

function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function resolveNearestExistingRealpath(targetPath: string): string {
  let current = path.resolve(targetPath);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const baseReal = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return tail.length > 0 ? path.join(baseReal, ...tail) : baseReal;
}

function isInsideGitWorktree(targetPath: string): boolean {
  const candidates = new Set<string>([
    path.resolve(targetPath),
    resolveNearestExistingRealpath(targetPath),
  ]);
  for (const start of candidates) {
    let current = start;
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return false;
}

/**
 * Inspect /proc/self/mountinfo on Linux (and UNC/network mount heuristics on non-Linux)
 * to reject network and VM mounts where WAL mode and POSIX locks are unreliable or unsafe.
 * Fails CLOSED if /proc/self/mountinfo cannot be read on Linux.
 */
export function checkFilesystemSafety(
  targetDir: string,
  options?: { mountinfoPath?: string; allowGitWorktree?: boolean; platformOverride?: NodeJS.Platform },
): void {
  const lexical = path.resolve(targetDir);
  if (!options?.allowGitWorktree && isInsideGitWorktree(lexical)) {
    throw new UnsafeFilesystemError(targetDir, "git-worktree");
  }

  const platform = options?.platformOverride ?? process.platform;
  const resolved = resolveNearestExistingRealpath(lexical);
  if (platform !== "linux") {
    // Major 6 (Slice 1a): Fail closed on non-Linux platforms where /proc/self/mountinfo is unavailable
    throw new UnsafeFilesystemError(targetDir, `unsupported-platform-${platform}-linux-only-slice-1a`);
  }

  // Explicit check for WSL drvfs (/mnt/c, etc.) on both lexical and resolved paths
  for (const p of [lexical, resolved]) {
    if (p.startsWith("/mnt/") && /^\/mnt\/[a-z](\/|$)/.test(p)) {
      throw new UnsafeFilesystemError(targetDir, "drvfs/9p (/mnt/<drive>)");
    }
  }

  const mountinfoPath = options?.mountinfoPath ?? "/proc/self/mountinfo";
  let mountinfo: string;
  try {
    mountinfo = fs.readFileSync(mountinfoPath, "utf8");
  } catch {
    // Fail CLOSED when mountinfo cannot be read on Linux.
    throw new UnsafeFilesystemError(targetDir, "unreadable-mountinfo");
  }

  let bestMount = "";
  let bestFstype = "";
  for (const line of mountinfo.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(" - ");
    if (parts.length < 2) continue;
    const leftParts = (parts[0] ?? "").split(" ");
    const rawMount = leftParts[4];
    const rightParts = (parts[1] ?? "").split(" ");
    const fstype = rightParts[0]?.toLowerCase();
    if (!rawMount || !fstype) continue;

    const mountPoint = unescapeMountPath(rawMount);
    const matches =
      mountPoint === "/" ||
      resolved === mountPoint ||
      resolved.startsWith(mountPoint.endsWith("/") ? mountPoint : mountPoint + "/");

    if (matches && mountPoint.length >= bestMount.length) {
      bestMount = mountPoint;
      bestFstype = fstype;
    }
  }

  if (!bestFstype) {
    throw new UnsafeFilesystemError(targetDir, "unparseable-mountinfo");
  }
  if (UNSAFE_FS_TYPES.has(bestFstype)) {
    throw new UnsafeFilesystemError(targetDir, bestFstype);
  }
}

function assertSingleSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0")) {
    throw new Error(`Invalid single path segment '${segment}'`);
  }
}

export function openDirFdNoFollow(targetPath: string): number {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
  try {
    return fs.openSync(targetPath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(`Symlink or non-directory component forbidden in flow path: ${targetPath}`);
    }
    throw err;
  }
}

/**
 * Open (or create with mode 0700 + parent fsync) a single direct child directory relative to an
 * already-pinned directory file descriptor via /proc/self/fd/<parentFd>/<segment> with O_DIRECTORY | O_NOFOLLOW.
 * Eliminates ancestor-swap TOCTOU windows.
 */
export function openConfinedSubdirFd(
  parentFd: number,
  segment: string,
  options?: { createMode?: number; allowMissing?: boolean },
): number | null {
  assertSingleSegment(segment);
  const fdPath = `/proc/self/fd/${parentFd}/${segment}`;
  try {
    return openDirFdNoFollow(fdPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (options?.createMode !== undefined) {
        let created = false;
        try {
          fs.mkdirSync(fdPath, { mode: options.createMode });
          created = true;
        } catch (mkErr) {
          if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr;
        }
        const childFd = openDirFdNoFollow(fdPath);
        try {
          try {
            fs.fchmodSync(childFd, options.createMode);
          } catch {
            // Ignore on filesystems without chmod support.
          }
          if (created) {
            fs.fsyncSync(parentFd);
          }
          return childFd;
        } catch (innerErr) {
          fs.closeSync(childFd);
          throw innerErr;
        }
      }
      if (options?.allowMissing) return null;
    }
    throw err;
  }
}

/**
 * Walk component-by-component strictly from "/" down to targetDir via pinned directory
 * descriptors (/proc/self/fd/<fd>/<segment>) with O_DIRECTORY | O_NOFOLLOW (ZERO qualified-pathname
 * directory opens anywhere in the walk).
 * Returns the open directory file descriptor for targetDir; caller MUST close it.
 */
export function openConfinedDirFd(
  targetDir: string,
  rootDir: string,
  options?: { createMode?: number },
): number {
  const confined = assertNoSymlinkInChain(targetDir, rootDir);
  const resolvedRoot = path.resolve(rootDir);
  let nearestExisting = resolvedRoot;
  while (!fs.existsSync(nearestExisting)) {
    const parent = path.dirname(nearestExisting);
    if (parent === nearestExisting) break;
    nearestExisting = parent;
  }
  const existingDepth = nearestExisting.split(path.sep).filter(Boolean).length;
  const segments = confined.split(path.sep).filter(Boolean);

  let curFd = openDirFdNoFollow("/");
  try {
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx]!;
      const allowCreate = options?.createMode !== undefined && idx >= existingDepth;
      const nextFd = openConfinedSubdirFd(curFd, seg, allowCreate ? { createMode: options.createMode } : undefined);
      if (nextFd === null) {
        throw new Error(`Missing directory segment '${seg}' while opening '${confined}'`);
      }
      fs.closeSync(curFd);
      curFd = nextFd;
    }
    return curFd;
  } catch (err) {
    try {
      fs.closeSync(curFd);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Critical 1 (Round 10): Snapshot open file descriptors in /proc/self/fd before a native
 * SQLite open, then locate the exact fd SQLite opened for `filename` and return its fstat
 * (ZERO open/close on the target inode, so POSIX fcntl locks held by SQLite are NEVER dropped).
 */
export function snapshotProcFds(): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of fs.readdirSync("/proc/self/fd")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // Closed descriptors (including readdirSync's own dirfd) throw ENOENT/EBADF and are excluded.
      const st = fs.fstatSync(Number(name));
      result.set(name, `${st.dev}:${st.ino}`);
    } catch {
      // ignore closed fd
    }
  }
  return result;
}

/**
 * Critical 1 (Round 10): Verify SQLite's actual open file descriptor for `expectedBasename` inside
 * `projectDirFd` matches `liveStat` (dev, ino, nlink === 1) via fstatSync on SQLite's own fd
 * (ZERO open/close, so POSIX fcntl locks are NEVER dropped).
 * Fails closed if the file was unlinked+replaced OR renamed+replaced between SQLite open() and check.
 */
export function verifyOpenedSqliteFileInDirFd(
  projectDirFd: number,
  beforeFds: ReadonlyMap<string, string>,
  expectedBasename: string,
  liveStat: fs.Stats | null,
): fs.Stats | null {
  if (!liveStat || !liveStat.isFile() || liveStat.nlink !== 1) return null;
  let expectedDirReal: string;
  try {
    expectedDirReal = fs.readlinkSync(`/proc/self/fd/${projectDirFd}`);
  } catch {
    return null;
  }
  const expectedFullPath = path.join(expectedDirReal, expectedBasename);
  const allowedSidecars = new Set([
    `${expectedBasename}-wal`,
    `${expectedBasename}-shm`,
    `${expectedBasename}-journal`,
  ]);

  let matched: fs.Stats | null = null;
  for (const name of fs.readdirSync("/proc/self/fd")) {
    if (!/^\d+$/.test(name)) continue;
    let linkTarget: string;
    let st: fs.Stats;
    try {
      linkTarget = fs.readlinkSync(`/proc/self/fd/${name}`);
      st = fs.fstatSync(Number(name));
    } catch {
      continue;
    }
    const cleanTarget = linkTarget.endsWith(" (deleted)")
      ? linkTarget.slice(0, -" (deleted)".length)
      : linkTarget;

    if (cleanTarget === expectedFullPath) {
      if (!st.isFile() || st.nlink !== 1 || st.dev !== liveStat.dev || st.ino !== liveStat.ino) {
        return null;
      }
      matched = st;
      continue;
    }

    // Detect rename-out-from-under-us: a brand-new regular-file fd inside expectedDirReal
    // that is neither the target nor an expected SQLite sidecar.
    if (
      st.isFile() &&
      path.dirname(cleanTarget) === expectedDirReal &&
      !allowedSidecars.has(path.basename(cleanTarget)) &&
      beforeFds.get(name) !== `${st.dev}:${st.ino}`
    ) {
      return null;
    }
  }
  return matched;
}

export function assertSafeRegularLstatInDirFd(dirFd: number, filename: string): fs.Stats | null {
  assertSingleSegment(filename);
  const fdPath = `/proc/self/fd/${dirFd}/${filename}`;
  const st = fs.lstatSync(fdPath, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) {
    throw new Error(`Symlink file forbidden: ${filename}`);
  }
  if (!st.isFile()) {
    throw new Error(`Expected regular file (non-regular inode forbidden): ${filename}`);
  }
  if (st.nlink > 1) {
    throw new Error(`Hard-linked file forbidden (nlink=${st.nlink}): ${filename}`);
  }
  return st;
}

export function precreateSafeFile0600InDirFd(dirFd: number, filename: string): void {
  assertSingleSegment(filename);
  const fdPath = `/proc/self/fd/${dirFd}/${filename}`;
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_RDWR |
    (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(fdPath, flags, 0o600);
    try {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Ignore on filesystems without chmod support.
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    throw err;
  }
}

function readRegularFileBytes(fd: number, size: number, filename: string, maxBytes?: number): Buffer {
  if (maxBytes === undefined) return fs.readFileSync(fd);
  if (size > maxBytes) throw new Error(`File exceeds size limit: ${filename}`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, bytes, offset, size - offset, offset);
    if (read === 0) throw new Error(`File changed while reading: ${filename}`);
    offset += read;
  }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) {
    throw new Error(`File changed while reading: ${filename}`);
  }
  return bytes;
}

export function assertSafeRegularFileInDirFd(
  dirFd: number,
  filename: string,
  options?: { chmod0600?: boolean; readBytes?: boolean; maxBytes?: number },
): { size: number; bytes?: Buffer } | null {
  assertSingleSegment(filename);
  const pre = assertSafeRegularLstatInDirFd(dirFd, filename);
  if (!pre) return null;

  const fdPath = `/proc/self/fd/${dirFd}/${filename}`;
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(fdPath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(`Symlink file forbidden: ${filename}`);
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Expected regular file (non-regular inode forbidden): ${filename}`);
    }
    if (st.nlink > 1) {
      throw new Error(`Hard-linked file forbidden (nlink=${st.nlink}): ${filename}`);
    }
    if (options?.chmod0600) {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Ignore on filesystems without chmod support.
      }
    }
    const bytes = options?.readBytes ? readRegularFileBytes(fd, st.size, filename, options.maxBytes) : undefined;
    return { size: st.size, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openDirFdNoFollow(dirPath);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fchmodDirNoFollow(dirPath: string, mode: number): void {
  const fd = openDirFdNoFollow(dirPath);
  try {
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Critical 1 & 2 + Major 2: Non-blocking lstat preflight (ZERO fd open/close, so it NEVER
 * drops POSIX fcntl locks held by the current process and NEVER blocks on a FIFO).
 * Returns null if ENOENT; throws on symlink, non-regular file (FIFO/socket/device/dir), or st_nlink > 1.
 */
export function assertSafeRegularLstat(filePath: string, rootDir: string): fs.Stats | null {
  const confined = assertNoSymlinkInChain(filePath, rootDir, { mustBeStrictDescendant: true });
  const st = fs.lstatSync(confined, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) {
    throw new Error(`Symlink file forbidden: ${confined}`);
  }
  if (!st.isFile()) {
    throw new Error(`Expected regular file (non-regular inode forbidden): ${confined}`);
  }
  if (st.nlink > 1) {
    throw new Error(`Hard-linked file forbidden (nlink=${st.nlink}): ${confined}`);
  }
  return st;
}

/**
 * Create a new 0600 file atomically via O_CREAT|O_EXCL|O_NOFOLLOW BEFORE opening SQLite,
 * so the file already has mode 0600 without ever opening/closing a raw fd while SQLite holds locks.
 */
export function precreateSafeFile0600IfMissing(filePath: string, rootDir: string): void {
  const confined = assertNoSymlinkInChain(filePath, rootDir, { mustBeStrictDescendant: true });
  const parentDir = path.dirname(confined);
  const filename = path.basename(confined);
  const parentFd = openConfinedDirFd(parentDir, rootDir);
  try {
    precreateSafeFile0600InDirFd(parentFd, filename);
  } finally {
    fs.closeSync(parentFd);
  }
}

/**
 * Critical 2 & Major 2: Verify an existing file inside rootDir via O_NOFOLLOW | O_NONBLOCK + fstatSync,
 * rejecting symlinks, FIFOs/non-regular files (without blocking!), and hard-linked regular files (st_nlink > 1),
 * and optionally apply fchmodSync(fd, 0o600) on the open descriptor.
 * WARNING: Never call on a SQLite DB/lock file while this process holds POSIX fcntl locks on that inode.
 * Returns null if the file does not exist (ENOENT).
 */
export function assertSafeRegularFile(
  filePath: string,
  rootDir: string,
  options?: { chmod0600?: boolean; readBytes?: boolean; maxBytes?: number },
): { size: number; bytes?: Buffer } | null {
  const confined = assertNoSymlinkInChain(filePath, rootDir, { mustBeStrictDescendant: true });
  // Fast non-blocking lstat check before open so FIFOs/symlinks/hard-links fail immediately
  const pre = assertSafeRegularLstat(confined, rootDir);
  if (!pre) return null;

  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(confined, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(`Symlink file forbidden: ${confined}`);
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Expected regular file (non-regular inode forbidden): ${confined}`);
    }
    if (st.nlink > 1) {
      throw new Error(`Hard-linked file forbidden (nlink=${st.nlink}): ${confined}`);
    }
    if (options?.chmod0600) {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Ignore on filesystems without chmod support.
      }
    }
    const bytes = options?.readBytes ? readRegularFileBytes(fd, st.size, confined, options.maxBytes) : undefined;
    return { size: st.size, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function findNearestExistingAncestor(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function configuredFlowsDataRoot(customDataRoot?: string): string | undefined {
  return customDataRoot ?? process.env["FLOWS_DATA_ROOT"] ?? process.env["DATA_ROOT"];
}

export function resolveFlowsRootDir(customDataRoot?: string): string {
  const rawRoot =
    configuredFlowsDataRoot(customDataRoot) ??
    path.join(os.homedir(), ".local", "share", "inkie-deck");
  const resolvedRoot = path.resolve(rawRoot);
  // Reject symlink dataRoot itself, git-worktree targets, AND any non-Git symlinked ancestor on Linux
  const rootStat = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`Symlink dataRoot forbidden: ${resolvedRoot}`);
  }
  if (isInsideGitWorktree(resolvedRoot)) {
    throw new UnsafeFilesystemError(resolvedRoot, "git-worktree");
  }
  if (process.platform === "linux") {
    const existingBase = findNearestExistingAncestor(resolvedRoot);
    if (fs.existsSync(existingBase) && fs.realpathSync(existingBase) !== existingBase) {
      throw new Error(`Symlink ancestor forbidden in dataRoot: ${resolvedRoot}`);
    }
  }
  const flowsDir = path.join(resolvedRoot, "flows");
  assertNoSymlinkInChain(flowsDir, resolvedRoot);
  return flowsDir;
}

/**
 * Single confined directory creation helper: checks every component from rootDir to targetDir
 * BEFORE any mkdir/chmod, creates missing segments one by one with mode 0700, and fsyncs
 * each parent directory whose entry was newly created (including rootDir's ancestors on first provision).
 */
export function ensureConfinedDir(targetDir: string, rootDir: string, mode = 0o700): string {
  const confined = assertNoSymlinkInChain(targetDir, rootDir);
  const fd = openConfinedDirFd(confined, rootDir, { createMode: mode });
  try {
    try {
      fs.fchmodSync(fd, mode);
    } catch {
      // Ignore on filesystems without chmod support.
    }
  } finally {
    fs.closeSync(fd);
  }
  return confined;
}

export function assertNoSymlinkInChain(
  targetPath: string,
  rootDir: string,
  options?: { mustBeStrictDescendant?: boolean },
): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (options?.mustBeStrictDescendant && resolvedTarget === resolvedRoot) {
    throw new Error(`Path '${targetPath}' must be a strict descendant of '${rootDir}'`);
  }

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path '${targetPath}' traverses outside confined root '${rootDir}'`);
  }

  // Check root itself if it exists
  if (fs.existsSync(resolvedRoot)) {
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
      throw new Error(`Symlink root forbidden: ${resolvedRoot}`);
    }
  }

  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel) return resolvedTarget;

  let current = resolvedRoot;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Symlink component forbidden in flow path: ${current}`);
    }
  }

  return resolvedTarget;
}

export function resolveProjectDataDir(projectId: string, customDataRoot?: string): string {
  if (!FlowIdRegex.test(projectId)) {
    throw new Error(`Invalid flow projectId '${projectId}': must match ${FlowIdRegex.source}`);
  }
  const flowsRoot = resolveFlowsRootDir(customDataRoot);
  const projectDir = path.join(flowsRoot, projectId);
  return assertNoSymlinkInChain(projectDir, flowsRoot);
}

export interface OwnerLock {
  projectId: string;
  lockPath: string;
  release(): void;
}

export function assertActiveOwnerLock(lock: OwnerLock | undefined, projectId: string, projectDir: string): void {
  if (!lock) {
    throw new OwnerLockRequiredError(projectId);
  }
  const meta = activeOwnerLockMeta.get(lock);
  if (!meta) {
    throw new OwnerLockRequiredError(projectId);
  }
  const realProjectDir = fs.existsSync(projectDir) ? fs.realpathSync(projectDir) : path.resolve(projectDir);
  const lockKey = path.join(meta.realProjectDir, "flows.owner");
  if (meta.realProjectDir !== realProjectDir || !inProcessLocks.has(lockKey)) {
    throw new OwnerLockRequiredError(projectId);
  }

  // Major 1: Verify BOTH projectDir inode AND flows.owner inode still match what we locked
  // (using lstatSync only - ZERO fd open/close so POSIX fcntl locks on flows.owner are never dropped).
  try {
    const pinnedDirStat = fs.fstatSync(meta.projectDirFd);
    const liveDirStat = fs.lstatSync(realProjectDir);
    if (
      liveDirStat.isSymbolicLink() ||
      !liveDirStat.isDirectory() ||
      liveDirStat.dev !== pinnedDirStat.dev ||
      liveDirStat.ino !== pinnedDirStat.ino
    ) {
      throw new OwnerLockRequiredError(projectId);
    }
    const ownerStat = fs.lstatSync(`/proc/self/fd/${meta.projectDirFd}/flows.owner`, { throwIfNoEntry: false });
    if (
      !ownerStat ||
      ownerStat.isSymbolicLink() ||
      !ownerStat.isFile() ||
      ownerStat.nlink !== 1 ||
      ownerStat.dev !== meta.ownerDev ||
      ownerStat.ino !== meta.ownerIno
    ) {
      throw new OwnerLockRequiredError(projectId);
    }
  } catch (err) {
    if (err instanceof OwnerLockRequiredError) throw err;
    throw new OwnerLockRequiredError(projectId);
  }
}

/**
 * Acquire the single-writer owner lock for a project's flow execution.
 * Throws RunnerLockBusyError if held by another process or another runner in-process.
 */
export function acquireOwnerLock(projectId: string, customDataRoot?: string): OwnerLock {
  const projectDir = resolveProjectDataDir(projectId, customDataRoot);
  checkFilesystemSafety(projectDir);

  const projectDirFd = openConfinedDirFd(projectDir, path.dirname(projectDir), { createMode: 0o700 });
  let ownershipTransferred = false;
  try {
    try {
      fs.fchmodSync(projectDirFd, 0o700);
    } catch {
      // Ignore on filesystems without chmod support.
    }

    const lockPath = assertNoSymlinkInChain(path.join(projectDir, "flows.owner"), projectDir, {
      mustBeStrictDescendant: true,
    });

    const realProjectDir = fs.realpathSync(projectDir);
    const lockKey = path.join(realProjectDir, "flows.owner");

    // Critical 1: Check inProcessLocks BEFORE opening or closing ANY raw fd on flows.owner!
    // On Linux, closing ANY fd to an inode releases all POSIX fcntl record locks held by this process.
    if (inProcessLocks.has(lockKey)) {
      throw new RunnerLockBusyError(projectId, lockPath);
    }

    // Critical 2 & Major 1/2: Reject symlinks, FIFOs, hard-linked flows.owner, or bind-mounted unsafe flows.owner
    // strictly through projectDirFd BEFORE opening SQLite, and pre-create with mode 0600 BEFORE acquiring POSIX locks.
    assertSafeRegularLstatInDirFd(projectDirFd, "flows.owner");
    assertSafeRegularLstatInDirFd(projectDirFd, "flows.owner-journal");
    checkFilesystemSafety(lockPath);
    precreateSafeFile0600InDirFd(projectDirFd, "flows.owner");
    assertSafeRegularFileInDirFd(projectDirFd, "flows.owner", { chmod0600: true });

    // Critical 1 (Round 10): Open flows.owner strictly through /proc/self/fd/<projectDirFd>/flows.owner
    // and capture the EXACT inode SQLite locked via fstatSync on SQLite's own open fd (zero open/close,
    // so POSIX locks are never dropped), then assert it matches the live directory entry!
    const fdLockPath = `/proc/self/fd/${projectDirFd}/flows.owner`;
    const fdsBeforeOpen = snapshotProcFds();
    let db: Database.Database;
    try {
      db = new Database(fdLockPath, { timeout: 100 });
    } catch {
      throw new RunnerLockBusyError(projectId, lockPath);
    }

    try {
      // Explicitly enforce rollback-journal mode + exclusive transaction for owner lock
      db.pragma("journal_mode = DELETE");
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("busy_timeout = 50");
      db.exec("BEGIN EXCLUSIVE;");
    } catch (err: unknown) {
      try {
        db.close();
      } catch {
        // ignore
      }
      const isBusy =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        ((err as { code: string }).code === "SQLITE_BUSY" || (err as { code: string }).code === "SQLITE_LOCKED");
      if (isBusy) {
        throw new RunnerLockBusyError(projectId, lockPath);
      }
      throw err;
    }

    // Major 5 (Round 11): Wrap post-open inode verification in try/catch so ANY thrown error
    // (e.g. symlink/hardlink refusal in assertSafeRegularLstatInDirFd) ALWAYS rolls back and
    // closes the exclusive SQLite lock connection immediately rather than leaking SQLITE_BUSY.
    let sqliteLockedStat: fs.Stats | null;
    try {
      const liveOwnerStat = assertSafeRegularLstatInDirFd(projectDirFd, "flows.owner");
      sqliteLockedStat = verifyOpenedSqliteFileInDirFd(
        projectDirFd,
        fdsBeforeOpen,
        "flows.owner",
        liveOwnerStat,
      );
      if (!sqliteLockedStat) {
        throw new OwnerLockRequiredError(projectId);
      }
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore
      }
      try {
        db.close();
      } catch {
        // ignore
      }
      throw err;
    }

    inProcessLocks.set(lockKey, db);

    let released = false;
    const ownerLock: OwnerLock = {
      projectId,
      lockPath,
      release() {
        if (released) return;
        released = true;
        activeOwnerLockMeta.delete(ownerLock);
        inProcessLocks.delete(lockKey);
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        try {
          db.close();
        } catch {
          // ignore
        }
        try {
          fs.closeSync(projectDirFd);
        } catch {
          // ignore
        }
      },
    };
    activeOwnerLockMeta.set(ownerLock, {
      realProjectDir,
      projectDirFd,
      ownerDev: sqliteLockedStat.dev,
      ownerIno: sqliteLockedStat.ino,
    });
    ownershipTransferred = true;
    return ownerLock;
  } finally {
    if (!ownershipTransferred) {
      try {
        fs.closeSync(projectDirFd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Test whether the owner lock is currently held by any process.
 */
export function isOwnerLocked(projectId: string, customDataRoot?: string): boolean {
  const projectDir = resolveProjectDataDir(projectId, customDataRoot);
  checkFilesystemSafety(projectDir);
  const lockPath = assertNoSymlinkInChain(path.join(projectDir, "flows.owner"), projectDir, {
    mustBeStrictDescendant: true,
  });
  const lockKey = fs.existsSync(projectDir)
    ? path.join(fs.realpathSync(projectDir), "flows.owner")
    : path.resolve(lockPath);

  if (inProcessLocks.has(lockKey)) {
    return true;
  }

  if (assertSafeRegularLstat(lockPath, projectDir) === null) {
    return false;
  }
  assertSafeRegularLstat(`${lockPath}-journal`, projectDir);
  checkFilesystemSafety(lockPath);

  try {
    const db = new Database(lockPath, { timeout: 50 });
    try {
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("busy_timeout = 50");
      db.exec("BEGIN EXCLUSIVE;");
      db.exec("ROLLBACK;");
      return false;
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    const isBusy =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      ((err as { code: string }).code === "SQLITE_BUSY" || (err as { code: string }).code === "SQLITE_LOCKED");
    return isBusy;
  }
}
