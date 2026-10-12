/**
 * file-pins.server.ts - per-thread file-pin persistence (SPEC 2 + D).
 *
 * Pins float a handful of files to the top of the Files panel and persist so
 * they survive a reload. Stored under DATA_ROOT (same root + atomic-write
 * discipline as FileQueueStore), keyed by (threadAgent, participant) so the operator
 * and a second user each pin in their OWN instance (author-agnostic, SPEC D - each
 * instance runs with its own mcUser + its own DATA_ROOT/data file).
 *
 * Shape: data/file-pins.json
 *   { version: 1, threads: { "<agent>::<participant>": { pins: [path, ...] } } }
 * pins[] is pin ORDER (first pinned first), which the panel renders top-down.
 *
 * Degrades to empty on any read failure. Atomic writes via
 * the shared confine + atomicWrite primitive.
 *
 * The .server suffix strips this from the client bundle.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  atomicWrite,
  assertNoLiveSiloRoot,
  confineToRootReal,
} from "./safe-fs.server.js";
import { resolveDataRoot } from "./queue.server.js";

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function pinsStatePath(): string {
  return (
    process.env["FILE_PINS_PATH"] ??
    path.join(process.cwd(), "data", "file-pins.json")
  );
}

/** Compose the per-thread key. Both names are roster-shaped, no separators. */
function threadKey(threadAgent: string, participant: string): string {
  return `${threadAgent}::${participant}`;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PinsStateSchema = z.object({
  version: z.literal(1),
  threads: z.record(
    z.string(),
    z.object({
      pins: z.array(z.string()),
    })
  ),
});

type PinsState = z.infer<typeof PinsStateSchema>;

const EMPTY_STATE: PinsState = { version: 1, threads: {} };

// ---------------------------------------------------------------------------
// FilePinsStore
// ---------------------------------------------------------------------------

/**
 * Persistent per-thread pin store.
 *
 * - getPins: ordered list of pinned paths for a thread (empty when none).
 * - pin: append a path to the end of the order (idempotent - no dup).
 * - unpin: remove a path (idempotent - no-op when absent).
 * - togglePin: pin if absent, unpin if present; returns the resulting state.
 *
 * v1 concurrency note (same as FileQueueStore): load-modify-save without a
 * lock; last-writer-wins. Acceptable for a single-user local instance where
 * pin taps are one-at-a-time.
 */
export class FilePinsStore {
  constructor(private readonly statePath: string = pinsStatePath()) {}

  private loadState(): PinsState {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = PinsStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        // Deep-ish copy so callers mutate freely.
        const threads: PinsState["threads"] = {};
        for (const [k, v] of Object.entries(parsed.data.threads)) {
          threads[k] = { pins: [...v.pins] };
        }
        return { version: 1, threads };
      }
      return { version: 1, threads: {} };
    } catch {
      return { version: 1, threads: {} };
    }
  }

  private saveState(state: PinsState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const rootReal = fs.realpathSync(resolveDataRoot());
    assertNoLiveSiloRoot(rootReal, "data");
    const resolved = confineToRootReal(this.statePath, rootReal, {
      forWrite: true,
      label: "data",
    });
    atomicWrite(resolved, JSON.stringify(state, null, 2) + "\n");
  }

  getPins(threadAgent: string, participant: string): string[] {
    const state = this.loadState();
    return state.threads[threadKey(threadAgent, participant)]?.pins ?? [];
  }

  pin(threadAgent: string, participant: string, filePath: string): string[] {
    const state = this.loadState();
    const key = threadKey(threadAgent, participant);
    const entry = state.threads[key] ?? { pins: [] };
    if (!entry.pins.includes(filePath)) {
      entry.pins.push(filePath);
      state.threads[key] = entry;
      this.saveState(state);
    }
    return entry.pins;
  }

  unpin(threadAgent: string, participant: string, filePath: string): string[] {
    const state = this.loadState();
    const key = threadKey(threadAgent, participant);
    const entry = state.threads[key];
    if (entry && entry.pins.includes(filePath)) {
      entry.pins = entry.pins.filter((p) => p !== filePath);
      state.threads[key] = entry;
      this.saveState(state);
      return entry.pins;
    }
    return entry?.pins ?? [];
  }

  togglePin(
    threadAgent: string,
    participant: string,
    filePath: string
  ): { pins: string[]; pinned: boolean } {
    const current = this.getPins(threadAgent, participant);
    if (current.includes(filePath)) {
      return { pins: this.unpin(threadAgent, participant, filePath), pinned: false };
    }
    return { pins: this.pin(threadAgent, participant, filePath), pinned: true };
  }
}

/** Default store instance (uses FILE_PINS_PATH or data/file-pins.json). */
export function makeFilePinsStore(): FilePinsStore {
  return new FilePinsStore();
}
