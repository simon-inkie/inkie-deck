import fs from "node:fs";
import { hasFlowSecretMarker } from "./checks.server.js";
import { loadFlowDefinition } from "./library.server.js";
import { acquireOwnerLock } from "./owner.server.js";
import { ledgerName, maxLedgerLines, openProjectionDirectory, readProjectionFile, type FlowProjectionTarget } from "./projection.server.js";
import { FlowProjectionError, openFlowsStore, prepareFlowProjection } from "./store.server.js";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const maxDefinitionBytes = 1024 * 1024;

function decodeLedger(bytes: Buffer): string[] {
  if (bytes.at(-1) !== 10) {
    throw new FlowProjectionError("The flow ledger must end with a line feed.", bytes.length ? 1 : 0);
  }
  const lines: string[] = [];
  let rejectedLines = 0;
  let lineCount = 0;
  for (let start = 0; start < bytes.length;) {
    if (++lineCount > maxLedgerLines) {
      throw new FlowProjectionError("The flow ledger exceeds the line limit.");
    }
    const end = bytes.indexOf(10, start);
    try {
      const line = utf8.decode(bytes.subarray(start, end));
      if (hasFlowSecretMarker(line)) rejectedLines += 1;
      lines.push(line);
    } catch {
      rejectedLines += 1;
    }
    start = end + 1;
  }
  if (rejectedLines) throw new FlowProjectionError("The flow ledger has invalid lines.", rejectedLines);
  return lines;
}

export function importFlowProgress(target: FlowProjectionTarget): { insertedLines: number; rejectedLines: number } {
  const { projectRoot, projectId, runId, dataRoot } = target;
  const dirFd = openProjectionDirectory(projectRoot, runId);
  try {
    const ledger = readProjectionFile(dirFd, ledgerName);
    if (!ledger) throw new FlowProjectionError("The flow ledger file is missing.");
    const projection = prepareFlowProjection(projectId, runId, decodeLedger(ledger), (plan) => {
      const pin = readProjectionFile(dirFd, "flow.yaml", maxDefinitionBytes);
      if (pin) return pin;
      try {
        const definition = loadFlowDefinition(plan.data.flowRef, {
          projectRoot, dataRoot, maxDefinitionBytes, expectedHash: plan.data.flowHash,
        });
        return Buffer.from(definition.yaml);
      } catch {
        throw new FlowProjectionError("The pinned flow definition could not be found.", 1);
      }
    }, dataRoot);
    const lock = acquireOwnerLock(projectId, dataRoot);
    try {
      const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
      try {
        return store.importProjection(projection);
      } finally {
        store.close();
      }
    } finally {
      lock.release();
    }
  } finally {
    fs.closeSync(dirFd);
  }
}
