/**
 * stores.server.ts
 *
 * makeStores(env) - the ONE swap point for all data-access implementations.
 *
 * This is the single factory function that routes and loaders call to get
 * typed data-access interfaces. It is the only place in the codebase where
 * concrete implementations (FileInboxRepository, NotImplementedQueueStore)
 * are constructed. A future DB-backed impl swaps here with no route/UI change.
 *
 * No route or component imports fs, a literal inbox path, or
 * constructs a FileInboxRepository directly. They only import makeStores
 * and consume the InboxRepository / QueueStore interfaces.
 *
 * The .server suffix strips this module from the client bundle (RR7 guarantee).
 *
 * Usage in a loader:
 *   import { makeStores } from "~/lib/stores.server";
 *   export async function loader() {
 *     const { inbox } = makeStores(process.env);
 *     const blocks = await inbox.readBlocks("scribe", "alex");
 *     return { blocks };
 *   }
 */

import path from "node:path";
import { FileInboxRepository } from "./inbox.server.js";
import type { InboxRepository } from "./inbox.server.js";
import { FileQueueStore } from "./queue.server.js";
import type { QueueStore } from "./queue.server.js";

// ---------------------------------------------------------------------------
// Stores shape
// ---------------------------------------------------------------------------

/**
 * The set of data-access stores returned by makeStores.
 * Routes and loaders destructure this to get the interfaces they need.
 */
export interface Stores {
  /** The inbox data-access interface. Read blocks, write replies, answer cards. */
  inbox: InboxRepository;
  /** The queue data-access interface (FileQueueStore backed by data/queue-state.json). */
  queue: QueueStore;
}

// ---------------------------------------------------------------------------
// makeStores
// ---------------------------------------------------------------------------

/**
 * Construct all data-access stores from the provided environment.
 *
 * This is the ONE swap point: to switch to a DB-backed InboxRepository or
 * a different QueueStore, change the concrete class instantiated here only.
 * Routes, loaders, and actions never change.
 *
 * @param env - The process environment (pass `process.env` from a loader/action).
 *   INBOX_ROOT must be set to an absolute path to the sandbox inbox directory.
 *   If unset, FileInboxRepository will throw when its first method is called (via resolveInboxRoot, which has no default).
 *   QUEUE_STATE_PATH may be set to override the default queue state file path.
 *   If unset, defaults to data/queue-state.json relative to process.cwd().
 *
 * @returns Stores - an object with `inbox` (InboxRepository) and
 *   `queue` (QueueStore behind the FileQueueStore implementation).
 */
export function makeStores(env: NodeJS.ProcessEnv): Stores {
  const inboxRoot = env["INBOX_ROOT"];

  const inbox: InboxRepository = new FileInboxRepository(
    // Pass inboxRoot if set; if undefined, FileInboxRepository will call
    // resolveInboxRoot() lazily and throw on first method call if INBOX_ROOT
    // is still not set in the environment.
    inboxRoot && inboxRoot.trim() !== "" ? inboxRoot : undefined
  );

  const queueStatePath =
    env["QUEUE_STATE_PATH"] ??
    path.join(process.cwd(), "data", "queue-state.json");
  const queue: QueueStore = new FileQueueStore(queueStatePath);

  return { inbox, queue };
}
