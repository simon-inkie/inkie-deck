/**
 * Process execution for the rig.
 *
 * WHY THIS EXISTS AT ALL, given that node ships spawnSync.
 *
 * The baseline discovery run found a check in this repository that scored a
 * MISSING BINARY as a successful match, because it wrote `result.status ?? 0`
 * and 0 was that check's code for success. spawnSync returns `status: null`
 * when the process never ran, and `??` cannot tell that apart from a real
 * exit code of zero. The product's own copy of that bug has since been fixed,
 * but the rig is the thing that has to notice when it comes back, so the rig
 * may not contain the same shape anywhere.
 *
 * Therefore: `status` is passed through unchanged, null included, and the
 * only sanctioned way to ask "did this succeed" is `.ok`, which is false for
 * a null status by construction. There is no coalescing operator in this file
 * and there should never be one applied to `status` anywhere in `rig/`.
 */
import { spawnSync } from "node:child_process";

/** Raised when a command the rig depends on could not be run at all. */
export class RigError extends Error {}

/**
 * @typedef {object} ExecResult
 * @property {string} file
 * @property {string[]} args
 * @property {number|null} status  exit code, or null when the process never produced one
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} output  stdout followed by stderr, for message matching
 * @property {Error|null} error
 * @property {boolean} spawnFailed  the binary was missing, or a signal killed it
 * @property {boolean} ok  ran, and exited 0
 */

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {ExecResult}
 */
export function exec(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    // Container logs are the evidence; truncating them would silently shorten
    // the verbatim failure text the report exists to carry.
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const spawnFailed = Boolean(result.error) || result.status === null;
  return {
    file,
    args,
    status: result.status,
    signal: result.signal ?? null,
    stdout,
    stderr,
    output: stdout + stderr,
    error: result.error ?? null,
    spawnFailed,
    ok: !spawnFailed && result.status === 0,
  };
}

/**
 * Run a command the rig itself depends on. A failure here is a RIG failure,
 * never a product one, so it throws rather than returning a red probe.
 *
 * @param {string} file @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {ExecResult}
 */
export function must(file, args, options = {}) {
  const result = exec(file, args, options);
  if (!result.ok) {
    const reason = result.spawnFailed
      ? `could not be run (${result.error ? result.error.message : `signal ${result.signal}`})`
      : `exited ${result.status}`;
    throw new RigError(
      `rig dependency failed: ${file} ${args.join(" ")} ${reason}\n${tail(result.output, 40)}`,
    );
  }
  return result;
}

/**
 * Strip terminal colour codes.
 *
 * Not cosmetics: vitest colours its own summary line, so `Tests  1770 passed`
 * arrives with escape sequences between the words and a regex written against
 * what a human sees on screen matches nothing. The first run of this rig
 * reported "the suite did not run" against a suite that had just run 1770
 * tests, which is the count instrument failing in the safe direction only by
 * luck. Every parser here works on stripped text.
 */
export function stripAnsi(text) {
  // The escape byte is written as a \u escape rather than embedded literally,
  // and the bracket is part of the pattern: matching `[0-9;]*[A-Za-z]` without
  // the escape would eat ordinary bracketed prefixes such as the production
  // launcher's own [prod] lines, quietly corrupting the evidence.
  return String(text ?? "").replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

/** Last `lines` lines of `text`, for reports that must stay readable. */
export function tail(text, lines = 30) {
  return stripAnsi(text).split("\n").slice(-lines).join("\n").trimEnd();
}
