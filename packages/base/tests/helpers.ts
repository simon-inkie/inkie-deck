/**
 * Shared test helpers for the `inbox` CLI test suite.
 *
 * Not itself a test module (vitest's default `include` glob only collects
 * files matching *.test.*, so this file is never collected).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const INBOX_PATH = path.join(REPO_ROOT, "bin", "inbox.mts");

// Every env var this CLI reads. Tests build environments from scratch (never
// inherit the developer's real shell) so a stray AGENT_NAME/SILO_HOME on the
// machine running the suite can never leak into a test and never mask a bug.
const INBOX_ENV_VARS = [
  "AGENT_NAME",
  "SILO_HOME",
  "ATTACHMENTS_ROOT",
  "INBOX_PUSH_BIN",
  "INBOX_PUSH",
  "INBOX_NO_PUSH",
  "INBOX_PUSH_FULLTEXT",
  "HOME",
] as const;

export type Env = Record<string, string>;

export interface BaseEnvOptions {
  agentName?: string | null;
  siloHome?: string | null;
  home?: string | null;
  extra?: Record<string, string>;
  push?: boolean;
}

/**
 * Build a clean subprocess environment for a CLI invocation.
 *
 * Strips every inbox-relevant var out of the real environment first, then
 * sets only what the test asks for. push=false (the default) sets
 * INBOX_NO_PUSH=1 so ordinary tests never attempt a live-wake push (that
 * binary is out of scope for this port); pass push=true to test the push
 * hand-off itself.
 */
export function baseEnv(options: BaseEnvOptions = {}): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of INBOX_ENV_VARS) {
    delete env[key];
  }
  // Keep PATH etc. so the interpreter and any subprocess it spawns works.
  if (options.agentName != null) {
    env.AGENT_NAME = options.agentName;
  }
  if (options.siloHome != null) {
    env.SILO_HOME = options.siloHome;
  }
  if (options.home != null) {
    env.HOME = options.home;
  }
  if (!options.push) {
    env.INBOX_NO_PUSH = "1";
  }
  if (options.extra) {
    Object.assign(env, options.extra);
  }
  return env;
}

export function runCli(
  args: string[],
  env: Env,
  { timeout = 30_000, input }: { timeout?: number; input?: string } = {},
): SpawnSyncReturns<string> {
  // process.execPath rather than a bare "node" so the suite always exercises
  // the same interpreter that is running it.
  return spawnSync(process.execPath, [INBOX_PATH, ...args], {
    env,
    encoding: "utf8",
    timeout,
    input,
  });
}

export function threadFile(siloHome: string, agent: string, correspondent: string): string {
  return path.join(siloHome, agent, "inbox", `${correspondent}.md`);
}

/**
 * Append a raw message block to `filePath` in the exact shape cmdReply
 * produces for a non-card message, simulating a message that some other
 * writer (e.g. a correspondent's own `inbox reply`, delivered into this
 * thread file by whatever mechanism makes the two sides' copies the same
 * file) already appended before this test's CLI invocation runs.
 */
export function seedBlock(
  filePath: string,
  ts: string,
  sender: string,
  status: string,
  subject: string,
  body: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const block = `\n## ${ts} - from: ${sender} - status: ${status} - subject: ${subject}\n\n${body.replace(/\s+$/, "")}\n`;
  fs.appendFileSync(filePath, block, "utf8");
}

/**
 * Python's tempfile.TemporaryDirectory equivalent.
 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "inbox-test-"));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run `fn` with `process.env` patched, restoring the whole environment after.
 *
 * The in-process tests (silo_home resolution, ATTACHMENTS_ROOT) read
 * process.env directly, so they must not leave the mutation behind for the
 * next test in the file. Keys with an `undefined` value are deleted.
 */
export function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const backup = { ...process.env };
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, backup);
  }
}
