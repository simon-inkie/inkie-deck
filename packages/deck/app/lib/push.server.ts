/**
 * push.server.ts - web-push plumbing: VAPID keys + subscription store.
 *
 * VAPID keys SELF-PROVISION on first use into DATA_ROOT/vapid-keys.json
 * (deliberate deviation from the plan's .mc-secrets.age idea: no secrets
 * ceremony, no risk to the daemon's ExecStart decrypt, and each instance
 * gets its own keypair automatically - subscriptions are per-instance, so
 * sharing a keypair bought nothing).
 *
 * Subscriptions live in DATA_ROOT/push-subscriptions.json - one list per
 * instance (per-instance DATA_ROOT = per-user automatically), multiple
 * devices per user supported, deduped by endpoint.
 *
 * Writes go through atomicWrite + the DATA_ROOT confinement guard - same
 * discipline as queue.server.ts. Any read failure returns the empty state
 * (tolerate-on-read).
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { z } from "zod";
import {
  atomicWrite,
  confineToRootReal,
  assertNoLiveSiloRoot,
} from "./safe-fs.server.js";
import { resolveDataRoot } from "./queue.server.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const VapidKeysSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});
export type VapidKeys = z.infer<typeof VapidKeysSchema>;

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type StoredSubscription = z.infer<typeof PushSubscriptionSchema> & {
  addedAt: string;
  ua?: string;
};

const SubscriptionStateSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(
    PushSubscriptionSchema.extend({
      addedAt: z.string(),
      ua: z.string().optional(),
    })
  ),
});
type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

const EMPTY_STATE: SubscriptionState = { version: 1, subscriptions: [] };

// ---------------------------------------------------------------------------
// Path helpers (constructor-pinned configuration, never request-derived)
// ---------------------------------------------------------------------------

function dataPath(file: string): string {
  return path.join(resolveDataRoot(), file);
}

function confinedWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const rootReal = fs.realpathSync(resolveDataRoot());
  assertNoLiveSiloRoot(rootReal, "data");
  const resolved = confineToRootReal(filePath, rootReal, {
    forWrite: true,
    label: "data",
  });
  atomicWrite(resolved, content);
}

// ---------------------------------------------------------------------------
// VAPID keys - lazy self-provision
// ---------------------------------------------------------------------------

/**
 * Return the instance's VAPID keypair, generating + persisting one on first
 * call. Generation is idempotent-enough for the single-daemon case (the
 * worst concurrent-boot race rewrites the file with a fresh valid pair
 * before any subscription exists).
 */
export function getVapidKeys(): VapidKeys {
  const file = dataPath("vapid-keys.json");
  try {
    const parsed = VapidKeysSchema.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8"))
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or malformed - fall through to generate.
  }
  const fresh = webpush.generateVAPIDKeys();
  confinedWrite(file, JSON.stringify(fresh, null, 2) + "\n");
  return fresh;
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

function loadState(): SubscriptionState {
  try {
    const raw = fs.readFileSync(dataPath("push-subscriptions.json"), "utf8");
    const parsed = SubscriptionStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    return EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(state: SubscriptionState): void {
  confinedWrite(
    dataPath("push-subscriptions.json"),
    JSON.stringify(state, null, 2) + "\n"
  );
}

/** List all stored subscriptions for this instance. */
export function listSubscriptions(): StoredSubscription[] {
  return loadState().subscriptions;
}

/** Add (or refresh) a subscription, deduped by endpoint. */
export function addSubscription(
  sub: z.infer<typeof PushSubscriptionSchema>,
  ua?: string
): void {
  const state = loadState();
  const without = state.subscriptions.filter(
    (s) => s.endpoint !== sub.endpoint
  );
  without.push({
    ...sub,
    addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(ua ? { ua } : {}),
  });
  saveState({ version: 1, subscriptions: without });
}

/** Remove a subscription by endpoint (unsubscribe or expiry cleanup). */
export function removeSubscription(endpoint: string): void {
  const state = loadState();
  const remaining = state.subscriptions.filter(
    (s) => s.endpoint !== endpoint
  );
  if (remaining.length !== state.subscriptions.length) {
    saveState({ version: 1, subscriptions: remaining });
  }
}
