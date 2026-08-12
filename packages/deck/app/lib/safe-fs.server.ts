/**
 * safe-fs.server.ts
 *
 * Root-table write confinement for every MC filesystem write (TASK-434).
 *
 * The old FND-04 guard was a blunt substring ban on ".the-vault". That was a
 * build-era invariant (test inbox only) encoded at the wrong layer: production
 * MC points INBOX_ROOT at the real ~/.the-vault/agents and must write there.
 * The rework replaces deny-known-bad with allowlist confinement:
 *
 *   confineToRoot(targetPath, root, opts) - THE shared primitive. A path is
 *     permitted only if its fully-resolved realpath sits inside the resolved
 *     root. Realpath BOTH sides; sep-suffixed prefix assert; no substring
 *     checks anywhere.
 *   assertSafeWritePath(targetPath) - inbox surface guard: confinement against
 *     INBOX_ROOT plus the inbox WRITE-SHAPE rule (<agent>/inbox/<file>.md).
 *     Root confinement alone is NOT enough for the inbox root: the production
 *     root also holds memory/, MEMORY.md, live-state.json - files MC must
 *     never touch even though they are inside the root.
 *   assertNoLiveSiloRoot(rootReal, label) - the old ban's intent, relocated:
 *     when MC_SANDBOX_ONLY is set (tests/CI/dev), any root resolving inside
 *     the real ~/.the-vault is refused outright. Production unsets it at
 *     cutover. Resolved against the real home directory, never string-matched.
 *   atomicWrite / atomicWriteBuffer - temp+same-dir-rename write primitives.
 *     LIB-INTERNAL discipline: only data-access seam modules (inbox, queue,
 *     attachments, projects) may import these, and every call must be preceded
 *     by a confinement assert. Routes use the seam, never these.
 *   safeWrite(targetPath, data) - assert + write convenience for the inbox seam.
 *
 * The .server suffix guarantees this module is stripped from the client bundle
 * by the RR7 bundler (FND-02 mechanism).
 *
 * Symlink semantics (load-bearing for the inbox thread mirror): thread files
 * are symlinked between agent folders. Both endpoints resolve INSIDE the root
 * and the resolved path is itself <agent>/inbox/<file>.md shaped, so the
 * mirror passes. A symlink resolving OUTSIDE the root fails the prefix assert
 * regardless of where it lives.
 *
 * atomicWrite is hand-rolled (temp file in the SAME directory + fs.renameSync;
 * POSIX rename within one filesystem is atomic) because write-file-atomic@8's
 * engine floor (^22.22.2) is above Node v22.22.0 on this machine.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Agent-name rule (shared with the attachments surface)
// ---------------------------------------------------------------------------

/**
 * ROSTER AGENT_NAME convention: lowercase alphanumeric + hyphens, starting
 * with an alphanumeric. Kills traversal (".."), dotfiles, empty segments and
 * separator smuggling at the name layer.
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// resolveInboxRoot
// ---------------------------------------------------------------------------

/**
 * Read process.env.INBOX_ROOT and return it as an absolute path string.
 *
 * Throws if:
 *   - INBOX_ROOT is unset or empty (FND-03: no default).
 *   - INBOX_ROOT is not an absolute path (relative paths are rejected).
 */
export function resolveInboxRoot(): string {
  const root = process.env["INBOX_ROOT"];
  if (!root || root.trim() === "") {
    throw new Error(
      "INBOX_ROOT is required but not set. " +
        "Set INBOX_ROOT to an absolute path to the inbox directory. " +
        "There is no default (FND-03)."
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `INBOX_ROOT must be an absolute path, got: "${root}". ` +
        "Relative paths are rejected (FND-03)."
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// assertNoLiveSiloRoot (MC_SANDBOX_ONLY semantics - the relocated FND-04 ban)
// ---------------------------------------------------------------------------

/**
 * When MC_SANDBOX_ONLY is set to a non-empty value (test/setup.ts sets "1";
 * dev .env should too), refuse any root that realpath-resolves to the real
 * ~/.the-vault or below. This preserves the original FND-04 intent - sandbox
 * configurations must never point at live agent silos - WITHOUT the per-write
 * substring matching that blocked production's legitimate paths.
 *
 * Production unsets MC_SANDBOX_ONLY as a deliberate step of the real-inbox
 * cutover (separate Alex-gated commit).
 *
 * The comparison is against the RESOLVED real home silo path, never a string
 * match, so test fixtures that happen to contain ".the-vault" in a tmpdir name
 * are unaffected.
 *
 * @param rootReal - The realpath-resolved root to vet.
 * @param label - Human label for the error message ("inbox", "attachments", ...).
 */
export function assertNoLiveSiloRoot(rootReal: string, label: string): void {
  const sandboxOnly = process.env["MC_SANDBOX_ONLY"];
  if (!sandboxOnly || sandboxOnly.trim() === "") return;

  const siloCandidate = path.join(os.homedir(), ".the-vault");
  let siloReal: string;
  try {
    siloReal = fs.realpathSync(siloCandidate);
  } catch {
    // No live silo on this machine (CI) - nothing to protect against.
    return;
  }

  if (rootReal === siloReal || rootReal.startsWith(siloReal + path.sep)) {
    throw new Error(
      `Refusing to operate: ${label} root "${rootReal}" resolves inside the live ` +
        `agent silo "${siloReal}" while MC_SANDBOX_ONLY is set. Sandbox ` +
        `configurations must never point at live silos (FND-04). Unset ` +
        `MC_SANDBOX_ONLY only as part of the deliberate production cutover.`
    );
  }
}

// ---------------------------------------------------------------------------
// confineToRoot - THE shared containment primitive
// ---------------------------------------------------------------------------

export interface ConfineOptions {
  /**
   * true: the target may not exist yet (new file) - ENOENT on the final
   *   component is tolerated and the parent-resolved path is used.
   * false: read access - the target must exist; ENOENT throws notFound.
   */
  forWrite: boolean;
  /** Human label for error messages ("inbox", "attachments", "projects", "data"). */
  label: string;
  /** Optional message for the forWrite:false not-found case. */
  notFound?: string;
}

/**
 * Confine targetPath inside rootReal (an ALREADY-REALPATHED root).
 *
 * The chain (every step load-bearing, see test/safe-fs.test.ts):
 *   1. realpath the PARENT directory of the target (the parent must exist -
 *      ENOENT propagates; this is what stops traversal-mkdir games) and join
 *      the basename: resolves symlinks in every intermediate component.
 *   2. If the final component exists, realpath it too: resolves a final-hop
 *      symlink (e.g. root/escape.md -> /outside/target.md). ENOENT here is
 *      tolerated only for writes (new file); reads throw notFound.
 *   3. sep-suffixed prefix assert: the fully-resolved path must equal rootReal
 *      or start with rootReal + path.sep ("/root-evil" must not match "/root").
 *
 * No substring checks. Escape attempts fail the prefix assert because their
 * RESOLVED path lands outside the root, wherever it points.
 *
 * @returns The fully-resolved absolute path, safe for fs operations.
 */
export function confineToRootReal(
  targetPath: string,
  rootReal: string,
  options: ConfineOptions
): string {
  // Step 1: parent realpath + basename join.
  const parentDir = path.dirname(targetPath);
  const parentReal = fs.realpathSync(parentDir);
  const resolved = path.join(parentReal, path.basename(targetPath));

  // Step 2: final-component realpath when the entry exists.
  let finalResolved = resolved;
  try {
    finalResolved = fs.realpathSync(resolved);
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (!options.forWrite) {
        throw new Error(
          options.notFound ?? `${options.label}: path not found: "${targetPath}".`
        );
      }
      // New file to be created - the parent-resolved path stands.
      finalResolved = resolved;
    } else {
      throw err;
    }
  }

  // Step 3: sep-suffixed prefix assert.
  if (
    finalResolved !== rootReal &&
    !finalResolved.startsWith(rootReal + path.sep)
  ) {
    throw new Error(
      `Refusing to access: resolved path "${finalResolved}" is outside the ` +
        `${options.label} root "${rootReal}". This may indicate a ` +
        `path-traversal or symlink-escape attempt (FND-03).`
    );
  }

  return finalResolved;
}

/**
 * Convenience wrapper: realpath the (possibly symlinked) root, apply the
 * MC_SANDBOX_ONLY live-silo refusal, then confine.
 *
 * @param root - The raw root path (absolute; typically from a *_ROOT env var).
 * @returns The fully-resolved absolute target path.
 */
export function confineToRoot(
  targetPath: string,
  root: string,
  options: ConfineOptions
): string {
  const rootReal = fs.realpathSync(root);
  assertNoLiveSiloRoot(rootReal, options.label);
  return confineToRootReal(targetPath, rootReal, options);
}

// ---------------------------------------------------------------------------
// assertSafeWritePath - the inbox surface (confinement + write shape)
// ---------------------------------------------------------------------------

/**
 * Assert that targetPath is safe for an INBOX write.
 *
 * Two layers:
 *   1. Confinement against INBOX_ROOT via confineToRoot (realpath both sides,
 *      prefix assert, MC_SANDBOX_ONLY live-silo refusal).
 *   2. WRITE SHAPE on the resolved-relative path: exactly
 *      <agentName>/inbox/<filename>.md, where agentName matches the ROSTER
 *      convention and filename is a single .md component. Asserted on the
 *      RESOLVED path (TASK-431 lesson: a symlinked intermediate must not be
 *      able to dress another write as an inbox write).
 *
 * Layer 2 is what keeps memory/, MEMORY.md, live-state.json and every other
 * silo file untouchable even when INBOX_ROOT is the production
 * ~/.the-vault/agents. It also denies traversal-shaped agent or participant
 * names whose joined path collapses outside any agent's inbox/ dir (the old
 * guard allowed e.g. "<root>/x.md").
 *
 * Layer 3 (optional, default-open): MC_INBOX_AGENT_ALLOWLIST - a comma-
 * separated list of agent names MC may write to. UNSET or empty = all agents
 * (Quill's call on the TASK-434 plan: MC messages are Alex's own messages, same
 * trust as direct inbox DMs; the hook exists so the list can be flipped the
 * moment a concrete risk shows, without a code change).
 *
 * All violations throw. Never warns silently.
 *
 * @returns The resolved absolute write path (safe to pass to atomicWrite).
 */
export function assertSafeWritePath(targetPath: string): string {
  const root = resolveInboxRoot();
  const rootReal = fs.realpathSync(root);
  assertNoLiveSiloRoot(rootReal, "inbox");

  const finalResolved = confineToRootReal(targetPath, rootReal, {
    forWrite: true,
    label: "inbox",
  });

  // Write-shape assert on the resolved-relative path.
  const rel = path.relative(rootReal, finalResolved);
  const parts = rel.split(path.sep);
  const shapeOk =
    parts.length === 3 &&
    AGENT_NAME_RE.test(parts[0]!) &&
    parts[1] === "inbox" &&
    parts[2]!.endsWith(".md") &&
    parts[2] !== ".md";
  if (!shapeOk) {
    throw new Error(
      `Refusing to write: resolved path "${finalResolved}" does not match the ` +
        `inbox write shape "<agent>/inbox/<file>.md" under root "${rootReal}" ` +
        `(FND-04). MC writes thread files only - never memory, state, or ` +
        `anything else inside an agent silo.`
    );
  }

  // Per-agent allowlist hook (default-open when unset).
  const allowed = getInboxAgentAllowlist();
  if (allowed && !allowed.has(parts[0]!)) {
    throw new Error(
      `Refusing to write: agent "${parts[0]}" is not in ` +
        `MC_INBOX_AGENT_ALLOWLIST (${[...allowed].join(", ")}).`
    );
  }

  return finalResolved;
}

/**
 * Parse MC_INBOX_AGENT_ALLOWLIST. Returns null when unset/empty (default-open:
 * all agents). Shared by the write guard (assertSafeWritePath) and the read
 * side (listAgents) so the UI never surfaces agents MC refuses to write to -
 * an inbox root can contain archived and scratch dirs (harness-*, archived-demo)
 * that are not conversation participants.
 */
export function getInboxAgentAllowlist(): Set<string> | null {
  const raw = process.env["MC_INBOX_AGENT_ALLOWLIST"];
  if (!raw || raw.trim() === "") return null;
  const allowed = raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  return allowed.length > 0 ? new Set(allowed) : null;
}

// ---------------------------------------------------------------------------
// validateConfiguredRoots (boot-time fail-fast, TASK-434)
// ---------------------------------------------------------------------------

/** The declared root table: every MC write surface and its root env var. */
const ROOT_ENV_VARS = [
  "INBOX_ROOT",
  "ATTACHMENTS_ROOT",
  "PROJECTS_ROOT",
  "DATA_ROOT",
] as const;

let rootsValidated = false;

/** Test-only: clear the validation memo so each case re-validates. */
export function resetRootsValidationForTests(): void {
  rootsValidated = false;
}

/**
 * Validate every configured root once per process (memoised). Called from the
 * root loader so a misconfigured deployment fails on the FIRST request with a
 * clear named-root error instead of a lazy 500 hours later (TASK-435 wants the
 * daemonised unit to die loudly at start).
 *
 * Per root: required (FND-03 no-default), absolute, must exist and
 * realpath-resolve, and must pass the MC_SANDBOX_ONLY live-silo refusal.
 *
 * Also WARNS (never throws) when two roots nest: the shape rules of one
 * surface could be end-run via the other. Warn-not-throw because
 * ATTACHMENTS_ROOT and PROJECTS_ROOT may legitimately share ancestry
 * under ~/brain.
 */
export function validateConfiguredRoots(): void {
  if (rootsValidated) return;

  const resolved: Array<{ name: string; real: string }> = [];
  for (const name of ROOT_ENV_VARS) {
    const value = process.env[name];
    if (!value || value.trim() === "") {
      throw new Error(
        `${name} is required but not set (TASK-434 boot validation). ` +
          `Set ${name} to an absolute path. There is no default (FND-03).`
      );
    }
    if (!path.isAbsolute(value)) {
      throw new Error(
        `${name} must be an absolute path, got: "${value}" (FND-03).`
      );
    }
    let real: string;
    try {
      real = fs.realpathSync(value);
    } catch {
      throw new Error(
        `${name} points at "${value}" which does not exist or cannot be ` +
          `resolved (TASK-434 boot validation).`
      );
    }
    assertNoLiveSiloRoot(real, name);
    resolved.push({ name, real });
  }

  for (const a of resolved) {
    for (const b of resolved) {
      if (a === b) continue;
      if (a.real === b.real || a.real.startsWith(b.real + path.sep)) {
        console.warn(
          `[safe-fs] root ${a.name} ("${a.real}") sits inside ${b.name} ` +
            `("${b.real}") - the write-shape rules of one surface could be ` +
            `bypassed via the other. Prefer disjoint roots.`
        );
      }
    }
  }

  rootsValidated = true;
}

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

/**
 * Write data to finalPath atomically using temp-file + same-dir fs.renameSync.
 *
 * The temp file is written to the same directory as finalPath so the rename
 * is within one filesystem (POSIX requirement for atomic rename).
 *
 * Does NOT confine the path - callers MUST run the relevant confinement
 * assert first (assertSafeWritePath / confineToRoot / surface guard). Only
 * data-access seam modules may import this; routes never do.
 */
export function atomicWrite(finalPath: string, data: string): void {
  const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, finalPath);
}

// ---------------------------------------------------------------------------
// atomicWriteBuffer (Buffer variant of atomicWrite for binary attachments)
// ---------------------------------------------------------------------------

/**
 * Write a Buffer to finalPath atomically using temp-file + same-dir fs.renameSync.
 *
 * Identical pattern to atomicWrite but accepts Buffer instead of string,
 * allowing binary data (images, etc.) to be written without encoding loss.
 *
 * Does NOT confine the path - callers must guard the path first.
 */
export function atomicWriteBuffer(finalPath: string, data: Buffer): void {
  const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, finalPath);
}

// ---------------------------------------------------------------------------
// withInboxLock (P1 lost-update fix, 2026-06-24)
// ---------------------------------------------------------------------------

const INBOX_LOCK_STALE_MS = 10_000; // legit holds are ms; >10s => holder died
const INBOX_LOCK_CEILING_MS = 30_000; // past this, throw LOUDLY (never drop a write)
const INBOX_LOCK_BACKOFF_MS = 4;
const INBOX_LOCK_JITTER_MS = 4;

const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run fn() while holding a cross-process advisory lock on `${resolvedPath}.lock`.
 *
 * WHY: inbox thread files are written by THREE uncoordinated processes - Alex's
 * MC, Robin's MC, and the agent CLI (packages/base/bin/inbox). Every MC write is a
 * full-file read-modify-write via atomicWrite (temp + rename); the rename swaps
 * the inode and ORPHANS any concurrent append, silently losing the message
 * (the P1 disappearing-message bug). atomicWrite stops torn files, not lost
 * updates, and nothing else serialises writers. This lock does.
 *
 * The READ must happen INSIDE fn() (i.e. inside the lock) so the snapshot the
 * rewrite is built from is fresh - locking around a stale snapshot fixes nothing.
 *
 * PROTOCOL - MUST stay equivalent at the FILE level to the Python CLI
 * (packages/base/bin/inbox, inlined `inbox_lock`) and any other implementation
 * (the same `inbox_lock` contract, wherever it is implemented), or MC and the CLI will
 * NOT mutually exclude:
 *   - lock path : "<resolvedPath>.lock"   (resolvedPath is the realpath-confined,
 *                 post-assertSafeWritePath inbox file - the SAME canonical path the
 *                 CLI locks on; the ".lock" suffix stays inside the confined inbox
 *                 dir, so no separate shape-guard is needed, and the .md-only
 *                 assertSafeWritePath would in fact reject it).
 *   - acquire   : O_EXCL create ('wx'); on EEXIST retry with jittered backoff. If
 *                 the holder's mtime is older than 10s it is presumed dead and
 *                 STOLEN ATOMICALLY via rename (only the winner of the rename
 *                 proceeds, so two waiters cannot both steal). Past 30s, throw.
 *   - release   : unlink ONLY if the lock still holds OUR token (a slow holder
 *                 that was stolen from must not unlink the stealer's lock).
 *
 * The O_EXCL lock also serialises writers WITHIN this process (a second async
 * task's create hits EEXIST and waits), so it doubles as the in-process mutex.
 */
export async function withInboxLock<T>(
  resolvedPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${resolvedPath}.lock`;
  const token = `${process.pid}:${process.hrtime.bigint()}:${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const deadline = Date.now() + INBOX_LOCK_CEILING_MS;

  // Parent must exist for the O_EXCL sibling (matches the CLI's makedirs-before-lock).
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
      fs.writeSync(fd, `${token}\n`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released; retry
      throw e;
    }
    if (ageMs > INBOX_LOCK_STALE_MS) {
      const steal = `${lockPath}.steal.${token}`;
      try {
        fs.renameSync(lockPath, steal); // ATOMIC: only one winner steals a dead lock
      } catch {
        continue; // lost the steal race - retry
      }
      try {
        fs.unlinkSync(steal);
      } catch {
        /* already gone */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `inbox lock ${lockPath} not acquired in ${INBOX_LOCK_CEILING_MS}ms`,
      );
    }
    await _sleep(
      INBOX_LOCK_BACKOFF_MS + Math.floor(Math.random() * INBOX_LOCK_JITTER_MS),
    );
  }

  try {
    return await fn();
  } finally {
    // Best-effort release: unlink only if the lock still holds our token.
    try {
      const held = fs.readFileSync(lockPath, "utf8").trim();
      if (held === token) fs.unlinkSync(lockPath);
    } catch {
      /* already released/stolen - nothing to do */
    }
  }
}

// ---------------------------------------------------------------------------
// safeWrite (convenience wrapper for the data-access seam in Plan 04)
// ---------------------------------------------------------------------------

/**
 * Assert the path is safe for an inbox write, then atomically write data to it.
 *
 * This is the entry point for the inbox data-access seam (inbox.server.ts)
 * to consume. Routes should never call atomicWrite directly.
 *
 * @returns The resolved path that was written (as returned by assertSafeWritePath).
 */
export function safeWrite(targetPath: string, data: string): string {
  const resolved = assertSafeWritePath(targetPath);
  atomicWrite(resolved, data);
  return resolved;
}
