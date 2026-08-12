/**
 * batch-durability.ts - stop losing composed messages that never left the browser.
 *
 * WHY THIS EXISTS (2026-07-26)
 * Submitting in MC does not send anything. usePendingBatch holds the text in a
 * CLIENT-SIDE batch and starts a settle timer (SETTLE_MS, 18s by default;
 * SAFETY_CAP_MS stretches it to 5 minutes while SUSPENDED). Only when that
 * elapses does anything reach the server or touch a file.
 *
 * So there is a window in which the message exists in exactly ONE place: this
 * tab's memory. Close the tab, switch apps, or let the phone sleep, and it is
 * gone with no trace on any server. Alex lost a link that way; the URL appears
 * exactly once on the machine, in the message where he asks whether we saw it.
 *
 * pending-batch.ts:225 described this precisely and deferred it to a "Phase 2"
 * that never came. A TODO that names a defect is worse than silence in one
 * specific way: it converts an unknown risk into a known-and-accepted one
 * without anyone deciding to accept it. Nobody weighed "Alex loses a message
 * from his phone" against the cost of a sendBeacon call.
 *
 * TWO HALVES, DELIBERATELY, because they cover different failures:
 *   1. sendBeacon on pagehide - covers the tidy cases: tab close, navigation,
 *      app switch, phone sleeping a background tab. Fires during unload, when
 *      a normal fetch would be cancelled.
 *   2. A localStorage mirror drained on next mount - covers what a beacon
 *      cannot: a crash, a force-quit, an OS kill, or a beacon that is simply
 *      dropped. This is the half that makes the batch DURABLE rather than
 *      merely likely to survive, and given the failure mode is a phone
 *      suspending a background tab, "likely" was doing a lot of work.
 *
 * Every entry point is SSR-safe and swallows storage errors (private mode,
 * quota, disabled storage): durability must never be able to break composing.
 */

/**
 * v2 as of 2026-07-29, and the bump is the FIX, not bookkeeping.
 *
 * Until that day the route mirrored under the currently-rendered agent instead
 * of the batch's owner, so switching threads mid-batch wrote thread A's text
 * into thread B's slot stamped `agentKey: "B"` (see pending-batch.ts's docblock
 * for the commit-timing mechanism). Such a record is indistinguishable from a
 * genuine one - self-consistent, correctly aged - and recovery delivers it as a
 * real compose POST into the WRONG inbox, up to 24h later. Three of Alex's
 * messages landed on the wrong agent that night.
 *
 * Alex's and Robin's browsers still hold v1 records written by the broken
 * code. Fixing the writer cannot unwrite them, and there is no way to tell a
 * poisoned v1 record from a good one after the fact. Reading under a new prefix
 * makes every one of them permanently inert - live mines defused by never being
 * looked at again, instead of by asking two humans to clear devtools correctly.
 * The dead keys can stay; a handful of stray localStorage entries cost nothing.
 *
 * Bump BOTH prefixes together on any future change to the record's meaning.
 */
export const KEY_PREFIX = "mc.pendingBatch.v2.";

// A fully independent prefix, not KEY_PREFIX plus a suffix: the two fixed
// strings diverge before any agentKey-controlled characters appear, so no
// agentKey value (dots, anything) can make a data key and a claim key
// collide and let one agent's recovery claim/delete another's.
export const CLAIM_KEY_PREFIX = "mc.pendingBatchClaim.v2.";

export interface PersistedBatch {
  /** Agent thread the batch belongs to. Recovery must not cross threads. */
  agentKey: string;
  paragraphs: string[];
  dictated: boolean;
  /** Epoch ms, used only to age out stale batches on recovery. */
  savedAt: number;
}

/**
 * Batches older than this are dropped on recovery rather than delivered. A
 * message resurrected days later is not a rescue, it is a surprise arriving
 * with no context, and the recipient cannot tell it is stale.
 */
export const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Batches younger than this are LEFT ALONE on recovery.
 *
 * A live tab re-mirrors on every change, so a very recent record probably
 * belongs to a session that is still composing. Without this floor, opening MC
 * in a second tab would drain the first tab's in-flight batch and send a
 * half-written message on the author's behalf. Recovery is for abandoned
 * sessions, and a session is only observably abandoned once it has stopped
 * touching its mirror.
 *
 * Comfortably above the default 18s settle so a normally-delivering batch is
 * cleared long before it becomes eligible.
 */
export const MIN_RECOVERY_AGE_MS = 60 * 1000;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // private mode / disabled / cross-origin restrictions
  }
}

function keyFor(agentKey: string): string {
  return `${KEY_PREFIX}${agentKey}`;
}

/**
 * Mirror the in-flight batch. Called whenever the held paragraphs change, so
 * the mirror is never more than one keystroke-settle behind the real state.
 * An empty batch clears rather than storing an empty record.
 */
export function saveBatch(
  agentKey: string,
  paragraphs: string[],
  dictated: boolean,
  now: number
): void {
  const s = storage();
  if (!s || !agentKey) return;
  if (!paragraphs.length) {
    clearBatch(agentKey);
    return;
  }
  const record: PersistedBatch = { agentKey, paragraphs, dictated, savedAt: now };
  try {
    s.setItem(keyFor(agentKey), JSON.stringify(record));
  } catch {
    // Quota or serialisation failure. The beacon half still covers the common
    // case, and failing to mirror must never break the compose path.
  }
}

/** The part of a pending batch the mirror needs. Satisfied by PendingBatchState. */
export interface MirrorableBatch {
  /** Which thread the paragraphs belong to. null in IDLE. */
  ownerKey: string | null;
  paragraphs: string[];
  dictated: boolean;
}

/**
 * Should the route's per-render mirror effect call saveBatch this time?
 *
 * Remote CodeRabbit review: this effect used to call saveBatch (and so,
 * on an empty batch, clearBatch) unconditionally once recovery had run. A
 * second tab mounting on the SAME agent thread starts with paragraphCount 0
 * (per-tab state) and would clear the FIRST tab's live, not-yet-delivered
 * mirror as a side effect of its own mount - the record takeRecoveredBatch
 * had correctly just left alone. Callers that legitimately empty a batch
 * (delivery, cancel) must clear explicitly instead of relying on this.
 *
 * The owner check (2026-07-29) is the second guard, for a different failure.
 * On the deliver-on-switch commit the mirror effect re-runs because `agent`
 * changed, while the reducer state it reads is still the OLD thread's - the
 * DELIVERED dispatch cannot re-render until the whole passive-effect flush
 * finishes. A batch whose owner is not the rendered thread has exactly one
 * legitimate fate, and the deliver-on-switch effect already owns it: it has
 * delivered the paragraphs and cleared their mirror in this same flush.
 * Mirroring here could only either mislabel them under the new thread or
 * resurrect them under the old one. So this returns false, and neither is
 * reachable.
 */
export function shouldMirrorBatch(
  recoveryDone: boolean,
  paragraphCount: number,
  ownerKey: string | null,
  renderedAgent: string
): boolean {
  return (
    recoveryDone &&
    paragraphCount > 0 &&
    ownerKey !== null &&
    ownerKey === renderedAgent
  );
}

/**
 * The route's mirror effect, whole: decide, then write under the batch's OWN
 * key. Returns whether it wrote.
 *
 * One function rather than a guard the caller pairs with its own saveBatch call,
 * because the bug was never in the decision - it was in the ARGUMENT. The route
 * had `agent` and `pendingBatch` both in scope and passed the wrong one as the
 * key, which reads perfectly and is wrong three effects later. Here the key is
 * not the caller's to choose.
 */
export function mirrorPendingBatch(
  batch: MirrorableBatch,
  recoveryDone: boolean,
  renderedAgent: string,
  now: number
): boolean {
  const owner = batch.ownerKey;
  // Narrowing, and the IDLE case: nothing owns an empty batch.
  if (owner === null) return false;
  if (!shouldMirrorBatch(recoveryDone, batch.paragraphs.length, owner, renderedAgent)) {
    return false;
  }
  saveBatch(owner, batch.paragraphs, batch.dictated, now);
  return true;
}

/** Drop the mirror. Call as soon as a batch is genuinely delivered. */
export function clearBatch(agentKey: string): void {
  const s = storage();
  if (!s || !agentKey) return;
  try {
    s.removeItem(keyFor(agentKey));
  } catch {
    /* ignore */
  }
}

/**
 * Recover the batch for ONE agent thread, claiming it before deleting.
 *
 * PER-AGENT (CodeRabbit Critical 2). The first version drained every agent's
 * record, so a route for agent A had to either deliver agent B's content or
 * delete it without recovering it. A thread may only ever touch its own batch.
 *
 * CLAIM BEFORE DELETE, because getItem-then-removeItem is not atomic: two tabs
 * could both read the same record and both deliver it, and a saveBatch landing
 * between the two calls would be deleted unread. The claim is a
 * last-write-wins token: whoever reads their own token back owns the record.
 *
 * Honest limit: localStorage has no compare-and-swap, so this narrows the race
 * rather than closing it. The complete answer is a server-side idempotency key
 * on the compose action. That is a separate change and is named on the MR
 * rather than pretended away here.
 *
 * At-most-once beats at-least-once throughout: the reader cannot tell a
 * duplicate from a repeated instruction.
 */
export function takeRecoveredBatch(
  agentKey: string,
  now: number,
  token: string
): {
  recovered: PersistedBatch | null;
  expired: PersistedBatch | null;
  skippedLive: boolean;
} {
  const s = storage();
  const none = { recovered: null, expired: null, skippedLive: false };
  if (!s || !agentKey) return none;

  const key = keyFor(agentKey);
  let parsed: PersistedBatch | null = null;
  try {
    const raw = s.getItem(key);
    if (!raw) return none;
    parsed = JSON.parse(raw) as PersistedBatch;
  } catch {
    try {
      s.removeItem(key); // corrupt: nothing to recover, do not retry it forever
    } catch {
      /* ignore */
    }
    return none;
  }
  if (!parsed || !Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length) {
    return none;
  }

  const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
  if (now - savedAt < MIN_RECOVERY_AGE_MS) {
    return { recovered: null, expired: null, skippedLive: true };
  }

  const claimKey = `${CLAIM_KEY_PREFIX}${agentKey}`;
  try {
    s.setItem(claimKey, token);
    if (s.getItem(claimKey) !== token) return none; // another tab won the claim
    s.removeItem(key);
  } catch {
    return none;
  }
  try {
    s.removeItem(claimKey);
  } catch {
    // The record is already claimed and removed above; a leftover claim key
    // is harmless (the next claimant's setItem overwrites it unconditionally),
    // so its cleanup failing must not discard the record we just recovered.
  }

  if (now - savedAt > MAX_RECOVERY_AGE_MS) {
    return { recovered: null, expired: parsed, skippedLive: false };
  }
  return { recovered: parsed, expired: null, skippedLive: false };
}

/**
 * Fire-and-forget flush during unload. Returns whether the browser accepted the
 * beacon; a false return is why the localStorage mirror is not optional.
 *
 * FormData is used (not JSON) so the payload arrives as a normal multipart POST
 * that the existing compose action parses with no server-side change.
 */
export function flushViaBeacon(
  url: string,
  body: string,
  dictated: boolean,
  targetAgent: string
): boolean {
  try {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
    if (!body) return false;
    const fd = new FormData();
    fd.set("intent", "compose");
    fd.set("body", body);
    if (dictated) fd.set("dictated", "1");
    if (targetAgent) fd.set("targetAgent", targetAgent);
    return navigator.sendBeacon(url, fd);
  } catch {
    return false;
  }
}
