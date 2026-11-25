/**
 * queue.server.ts
 *
 * QueueStore interface - the data-access contract for the SLA action-queue.
 *
 * Phase 3: real FileQueueStore implementation backed by data/queue-state.json.
 * Handled ids and absolute deadline anchors persist atomically.
 *
 * Per CONTEXT.md: "SLA action-queue logic and queue-state.json persistence - Phase 3".
 *
 * The .server suffix strips this module from the client bundle (RR7 guarantee).
 *
 * T-03-01 (DoS): QueueStateSchema.safeParse + try/catch returns EMPTY_STATE on
 * any read failure (invalid JSON or schema mismatch). The app degrades to an
 * empty queue instead of crashing.
 *
 * T-03-02 (Tampering): Writes target statePath under DATA_ROOT via the shared
 * confinement primitive + atomicWrite (this closed the one raw
 * atomicWrite bypass - every Deck write is now confined to a declared root).
 * assertSafeWritePath is NOT called - queue state is not inbox-shaped; it has
 * its own root (DATA_ROOT) in the root table.
 *
 * T-03-03 (Tampering): atomicWrite uses temp-file + same-dir rename so a crash
 * leaves either the old file or the new file, never a half-written one.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  atomicWrite,
  assertNoLiveSiloRoot,
  confineToRootReal,
} from "./safe-fs.server.js";

// ---------------------------------------------------------------------------
// resolveDataRoot
// ---------------------------------------------------------------------------

/**
 * Read process.env.DATA_ROOT and return it as an absolute path string.
 *
 * DATA_ROOT is the declared root for Deck's own state files (queue state).
 * Explicit env, no derivation: throws if unset/empty/relative.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env["DATA_ROOT"];
  if (!root || root.trim() === "") {
    throw new Error(
      "DATA_ROOT is required but not set. " +
        "Set DATA_ROOT to an absolute path to Deck's state directory " +
        "(e.g. <repo>/data). There is no default."
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `DATA_ROOT must be an absolute path, got: "${root}". ` +
        "Relative paths are rejected."
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// QueueStore interface (leaner Phase 3 shape)
// ---------------------------------------------------------------------------

/**
 * Data-access contract for the SLA action-queue.
 *
 * All routes and loaders consume this interface via makeStores().
 * The real implementation is FileQueueStore; a future SqliteQueueStore
 * or PostgresQueueStore swaps in behind this interface with no route change.
 */
export interface QueueStore {
  /** Get the set of ids that have been explicitly marked handled. */
  getHandled(): Promise<Set<string>>;
  /** Get the map of id -> ISO deadline anchor. */
  getDeadlines(): Promise<Map<string, string>>;
  /** Persist a deadline anchor for a newly-discovered item (idempotent - no-op if already set). */
  setDeadline(id: string, deadline: string): Promise<void>;
  /** Mark an item as handled (idempotent - no-op if already handled). */
  markHandled(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// queue-state.json schema
// ---------------------------------------------------------------------------

export const QueueStateSchema = z.object({
  version: z.literal(1),
  deadlines: z.record(z.string(), z.string()), // id -> ISO deadline anchor
  handled: z.array(z.string()),                 // explicitly handled ids
});

export type QueueState = z.infer<typeof QueueStateSchema>;

const EMPTY_STATE: QueueState = { version: 1, deadlines: {}, handled: [] };

// ---------------------------------------------------------------------------
// FileQueueStore
// ---------------------------------------------------------------------------

/**
 * Persistent QueueStore backed by a JSON file at statePath.
 *
 * - Reads use fs.promises.readFile + QueueStateSchema.safeParse.
 * - Writes use atomicWrite (temp-file + rename, same directory).
 * - Any read failure (ENOENT, bad JSON, schema mismatch) returns EMPTY_STATE.
 * - markHandled is monotonic: ids are never removed from the handled set.
 * - setDeadline is first-write-wins: subsequent calls for the same id are no-ops.
 * - The parent directory is created lazily on first write.
 *
 * v1 concurrency note: markHandled and setDeadline both do an async loadState
 * followed by a sync saveState (read-modify-write without a lock). Simultaneous
 * calls can race: the second writer overwrites the first's result (last-writer-wins).
 * The worst-case failure is a handled item REAPPEARING on next load (the non-handled
 * version wins the race). For a single-user local tool this is acceptable -- the
 * interaction rate is one action at a time. If multi-writer scenarios arise (e.g.
 * background sync + user action), add a simple in-process serialising write queue
 * (a promise chain per instance) before this becomes a reliability concern.
 */
export class FileQueueStore implements QueueStore {
  constructor(private readonly statePath: string) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadState(): Promise<QueueState> {
    try {
      const raw = await fs.promises.readFile(this.statePath, "utf8");
      const parsed = QueueStateSchema.safeParse(JSON.parse(raw));
      // Deep-copy so callers can mutate .handled/.deadlines without tainting
      // the parsed object or the EMPTY_STATE fallback.
      if (parsed.success) {
        return {
          version: parsed.data.version,
          deadlines: { ...parsed.data.deadlines },
          handled: [...parsed.data.handled],
        };
      }
      return { version: 1, deadlines: {}, handled: [] };
    } catch {
      // ENOENT, bad JSON, or schema mismatch - degrade to an empty queue.
      return { version: 1, deadlines: {}, handled: [] };
    }
  }

  private saveState(state: QueueState): void {
    // statePath is constructor-pinned configuration (never request-derived),
    // so creating its parent before confinement is acceptable; the confine
    // then verifies the resolved location sits inside DATA_ROOT before any
    // bytes are written.
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const rootReal = fs.realpathSync(resolveDataRoot());
    assertNoLiveSiloRoot(rootReal, "data");
    const resolved = confineToRootReal(this.statePath, rootReal, {
      forWrite: true,
      label: "data",
    });
    atomicWrite(resolved, JSON.stringify(state, null, 2) + "\n");
  }

  // ---------------------------------------------------------------------------
  // QueueStore interface
  // ---------------------------------------------------------------------------

  async getHandled(): Promise<Set<string>> {
    const state = await this.loadState();
    return new Set(state.handled);
  }

  async getDeadlines(): Promise<Map<string, string>> {
    const state = await this.loadState();
    return new Map(Object.entries(state.deadlines));
  }

  async markHandled(id: string): Promise<void> {
    const state = await this.loadState();
    if (!state.handled.includes(id)) {
      state.handled.push(id);
      this.saveState(state);
    }
  }

  async setDeadline(id: string, deadline: string): Promise<void> {
    const state = await this.loadState();
    if (!state.deadlines[id]) {
      state.deadlines[id] = deadline;
      this.saveState(state);
    }
  }
}
