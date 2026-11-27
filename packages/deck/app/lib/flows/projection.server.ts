import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasFlowSecretMarker } from "./checks.server.js";
import { acquireOwnerLock, assertSafeRegularFileInDirFd, openConfinedDirFd } from "./owner.server.js";
import { FlowRunNotFoundError, listFlowRuns } from "./reader.server.js";
import { FlowProjectionError, openFlowsStore } from "./store.server.js";
import { FlowIdRegex } from "./types.js";

export const ledgerName = "events.jsonl";
const maxLedgerBytes = 8 * 1024 * 1024;
export const maxLedgerLines = 10_000;

export type FlowProjectionTarget = {
  projectRoot: string;
  projectId: string;
  runId: string;
  dataRoot?: string;
};

function ledgerDirectory(runId: string): string {
  if (!FlowIdRegex.test(runId)) throw new FlowProjectionError("Invalid flow run id.");
  return `.deck/runs/${runId}`;
}

export function openProjectionDirectory(projectRoot: string, runId: string, create = false): number {
  const relative = ledgerDirectory(runId);
  try {
    return openConfinedDirFd(path.join(projectRoot, relative), projectRoot, create ? { createMode: 0o755 } : undefined);
  } catch {
    throw new FlowProjectionError("The flow ledger directory is missing or unsafe.");
  }
}

export function readProjectionFile(dirFd: number, filename: string, maxBytes = maxLedgerBytes): Buffer | undefined {
  try {
    return assertSafeRegularFileInDirFd(dirFd, filename, { readBytes: true, maxBytes })?.bytes;
  } catch {
    throw new FlowProjectionError("The flow projection file is unsafe or too large.");
  }
}

function gitHeadLedger(projectRoot: string, relative: string): Buffer | undefined {
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: projectRoot, timeout: 5_000, maxBuffer: maxLedgerBytes + 1,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let head: string;
  try {
    if (git(["rev-parse", "--show-toplevel"]).toString().trimEnd() !== projectRoot) {
      throw new FlowProjectionError("Flow projection requires the root of a Git checkout.");
    }
    try {
      head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).toString().trim();
    } catch (err) {
      if ((err as { status?: number }).status === 1) return undefined;
      throw err;
    }
    const entry = git(["ls-tree", "-z", head, "--", relative]).toString();
    if (!entry) return undefined;
    const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/.exec(entry);
    if (!match) throw new FlowProjectionError("The committed ledger is not a regular file.");
    return git(["cat-file", "blob", match[1]!]);
  } catch (err) {
    if (err instanceof FlowProjectionError) throw err;
    throw new FlowProjectionError("Could not verify the ledger in Git HEAD.");
  }
}

function assertLedgerPrefix(prefix: Buffer | undefined, ledger: Buffer): void {
  if (prefix && ((prefix.length > 0 && prefix.at(-1) !== 10) ||
    !ledger.subarray(0, prefix.length).equals(prefix))) {
    throw new FlowProjectionError("The existing flow ledger is ahead of or diverges from the local run.");
  }
}

/** Preserve the verified prefix and publish a complete durable file in one rename. */
export function projectFlowProgress(target: FlowProjectionTarget): { appendedLines: number } {
  const { projectId, runId, dataRoot } = target;
  const projectRoot = path.resolve(target.projectRoot);
  const relative = `${ledgerDirectory(runId)}/${ledgerName}`;
  if (!listFlowRuns(projectId, { dataRoot }).some((run) => run.runId === runId)) {
    throw new FlowRunNotFoundError(projectId, runId);
  }
  const lock = acquireOwnerLock(projectId, dataRoot);
  try {
    const store = openFlowsStore(projectId, { dataRoot, readonly: true });
    let lines: string[];
    try {
      lines = store.exportProjectionLines(runId);
    } finally {
      store.close();
    }
    if (!lines.length) throw new FlowProjectionError("Flow run has no events to project.");
    const bytes = Buffer.from(lines.join("\n") + "\n", "utf8");
    if (bytes.length > maxLedgerBytes || lines.length > maxLedgerLines) {
      throw new FlowProjectionError("The flow ledger exceeds the projection size limit.");
    }
    if (hasFlowSecretMarker(bytes.toString("utf8"))) {
      throw new FlowProjectionError("The flow ledger contains a possible secret.");
    }
    assertLedgerPrefix(gitHeadLedger(projectRoot, relative), bytes);

    const dirFd = openProjectionDirectory(projectRoot, runId, true);
    const filename = `/proc/self/fd/${dirFd}/${ledgerName}`;
    const temporary = `${filename}.tmp.${randomUUID()}`;
    try {
      const existing = readProjectionFile(dirFd, ledgerName);
      assertLedgerPrefix(existing, bytes);
      if (existing?.equals(bytes)) return { appendedLines: 0 };

      fs.writeFileSync(temporary, bytes, { flag: "wx", flush: true });
      const current = readProjectionFile(dirFd, ledgerName);
      if (existing ? !current?.equals(existing) : current !== undefined) {
        throw new FlowProjectionError("The flow ledger changed during projection.");
      }
      fs.renameSync(temporary, filename);
      fs.fsyncSync(dirFd);
      const existingLines = existing?.length ? existing.toString("utf8").split("\n").length - 1 : 0;
      return { appendedLines: lines.length - existingLines };
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } finally {
    lock.release();
  }
}
