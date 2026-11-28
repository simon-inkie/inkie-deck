/**
 * load-run.server.ts - Confinement, pin verification, and run loader for Deck task flows.
 *
 * Enforces loader invariants:
 * - Two disjoint roots: private state under <DATA_ROOT>/flows/<project-id>/ and project run root.
 * - Loader pin check: verified flow definition bytes must match flow_hash exactly before execution/resume.
 * - Run ID match & directory binding: rejects cross-run event pollution and directory mismatches.
 * - Path confinement: safe path canonicalization checking EVERY ancestor component for symlinks/traversal.
 * - Artefact verification: verifies actual file existence, byte size, and SHA-256 on disk per receipt.
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FlowIdRegex, type FlowEvent, type FlowRunState, type FlowDefinition } from "./types.js";
import { parseFlowYamlOrThrow } from "./validator.js";
import { reduceFlowRun } from "./replay.js";
import type { FlowRunRow } from "./store.server.js";
import { openFlowsStore } from "./store.server.js";
import {
  assertNoSymlinkInChain,
  assertSafeRegularFile,
  assertSafeRegularFileInDirFd,
  openConfinedDirFd,
  openConfinedSubdirFd,
  resolveFlowsRootDir,
  resolveProjectDataDir,
} from "./owner.server.js";

export class FlowPinMismatchError extends Error {
  constructor(public readonly runId: string, public readonly expectedHash: string, public readonly actualHash: string) {
    super(`Flow definition pin mismatch for run '${runId}': expected ${expectedHash}, got ${actualHash}`);
    this.name = "FlowPinMismatchError";
  }
}

export class PathConfinementError extends Error {
  constructor(public readonly attemptedPath: string, public readonly rootPath: string) {
    super(`Path '${attemptedPath}' traverses outside confined root '${rootPath}'`);
    this.name = "PathConfinementError";
  }
}

export class SymlinkNotAllowedError extends Error {
  constructor(public readonly targetPath: string) {
    super(`Symlinks are forbidden for flow execution files: ${targetPath}`);
    this.name = "SymlinkNotAllowedError";
  }
}

/**
 * Verify that a path is strictly confined within root and contains NO symlinks
 * at the root, at any intermediate ancestor component, or at the final target.
 * Delegates directly to owner.server.ts's single confinement walker.
 */
export function assertConfinedPath(targetPath: string, rootDir: string): string {
  try {
    return assertNoSymlinkInChain(targetPath, rootDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("traverses outside") || msg.includes("strict descendant")) {
      throw new PathConfinementError(targetPath, rootDir);
    }
    if (msg.includes("Symlink")) {
      throw new SymlinkNotAllowedError(targetPath);
    }
    throw err;
  }
}

/**
 * Verify an artefact file on disk: strictly confined, regular non-symlink, single-link
 * (st_nlink === 1) file opened with O_NOFOLLOW, exact byte size and SHA-256 hash match.
 */
export function verifyArtifactFileOnDisk(
  filePath: string,
  artifactsRoot: string,
  expectedHash: string,
  expectedSize: number,
): boolean {
  try {
    const confined = assertConfinedPath(filePath, artifactsRoot);
    const verified = assertSafeRegularFile(confined, artifactsRoot, { readBytes: true });
    if (!verified || !verified.bytes || verified.size !== expectedSize || verified.bytes.length !== expectedSize) {
      return false;
    }
    const actualHash = crypto.createHash("sha256").update(verified.bytes).digest("hex");
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

export function verifyArtifactFileInDirFd(
  runDirFd: number,
  expectedHash: string,
  expectedSize: number,
): boolean {
  try {
    const verified = assertSafeRegularFileInDirFd(runDirFd, expectedHash, { readBytes: true });
    if (!verified || !verified.bytes || verified.size !== expectedSize || verified.bytes.length !== expectedSize) {
      return false;
    }
    const actualHash = crypto.createHash("sha256").update(verified.bytes).digest("hex");
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Load complete run record, verify pin hash against pinned flow bytes,
 * verify event hash chain and envelope binding, verify real artefact files on disk,
 * reduce state via replay fold, and return composite verified state.
 */
export function loadRunState(
  projectId: string,
  runId: string,
  options?: { dataRoot?: string }
): {
  run: FlowRunRow;
  flow: FlowDefinition;
  events: FlowEvent[];
  state: FlowRunState;
  pinnedFlowYaml: string;
  verifiedArtefacts: Map<string, number>;
  readOnly: boolean;
} {
  if (!FlowIdRegex.test(projectId)) {
    throw new PathConfinementError(projectId, "flows");
  }
  if (!FlowIdRegex.test(runId)) {
    throw new Error(`Invalid flow runId '${runId}'`);
  }

  const flowsRoot = resolveFlowsRootDir(options?.dataRoot);
  const projectDir = resolveProjectDataDir(projectId, options?.dataRoot);
  assertConfinedPath(projectDir, flowsRoot);

  const store = openFlowsStore(projectId, { dataRoot: options?.dataRoot, readonly: true });
  try {
    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Flow run '${runId}' not found for project '${projectId}'`);
    }

    // Loader pin check
    const pinnedBytes = store.getPinnedFlow(run.flow_hash);
    if (!pinnedBytes) {
      throw new Error(`Pinned flow definition bytes missing for flow hash '${run.flow_hash}'`);
    }

    const calculatedHash = crypto.createHash("sha256").update(pinnedBytes).digest("hex");
    if (calculatedHash !== run.flow_hash) {
      throw new FlowPinMismatchError(runId, run.flow_hash, calculatedHash);
    }

    const pinnedFlowYaml = pinnedBytes.toString("utf8");
    const flowValidation = parseFlowYamlOrThrow(pinnedFlowYaml);
    const flow = flowValidation.flow;

    // Verify hash chain and envelope/column binding
    store.verifyHashChain(runId);

    // Read and parse all events
    const events = store.getParsedEvents(runId);
    const readOnly = store.isImportedRun(runId);

    // Verify recorded artefacts against actual files on disk using pinned dirfds (never trust SQL metadata alone)
    const artifactRows = readOnly ? [] : store.listArtifacts(runId);
    const verifiedArtefacts = new Map<string, number>();

    if (artifactRows.length > 0) {
      const projectDirFd = openConfinedDirFd(projectDir, flowsRoot);
      try {
        const artifactsParentFd = openConfinedSubdirFd(projectDirFd, "artifacts", { allowMissing: true });
        if (artifactsParentFd !== null) {
          try {
            const runDirFd = openConfinedSubdirFd(artifactsParentFd, runId, { allowMissing: true });
            if (runDirFd !== null) {
              try {
                for (const art of artifactRows) {
                  if (verifyArtifactFileInDirFd(runDirFd, art.content_hash, art.size)) {
                    verifiedArtefacts.set(`${art.artifact_id}:${art.content_hash}`, art.size);
                  }
                }
              } finally {
                fs.closeSync(runDirFd);
              }
            }
          } finally {
            fs.closeSync(artifactsParentFd);
          }
        }
      } finally {
        fs.closeSync(projectDirFd);
      }
    }

    // Imported receipts describe historical evidence. Only live runs use verified
    // local artefacts as inputs.
    const historicalReceipts = new Map<string, number>();
    if (readOnly) {
      for (const event of events) {
        if (event.type === "artefact_recorded") {
          const { artefactId, sha256, sizeBytes } = event.data;
          historicalReceipts.set(`${artefactId}:${sha256}`, sizeBytes);
        }
      }
    }
    const state = reduceFlowRun(flow, events, readOnly ? historicalReceipts : verifiedArtefacts);

    return {
      run,
      flow,
      events,
      state,
      pinnedFlowYaml,
      verifiedArtefacts,
      readOnly,
    };
  } finally {
    store.close();
  }
}
