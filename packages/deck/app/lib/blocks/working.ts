/**
 * working.ts - Pure helpers for the "working" receipt state (TASK-444).
 *
 * These functions derive display-state from the ordered block list.
 * They are pure: no IO, no fs, no env access, no .server imports (FND-02).
 *
 * The "working" status means an agent has picked up a message and is
 * actively processing it. The indicator clears once the agent replies:
 * any non-alex block appearing AFTER the working block supersedes it,
 * and the superseded block falls back to the "read" receipt state.
 *
 * Status precedence: working (live) > read > sent. Unknown -> sent.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { formatDistance } from "date-fns";
import type { MessageBlock } from "./model.js";

/**
 * Returns true when any block AFTER index has header.from !== user.
 * This signals the agent has replied, superseding the working indicator.
 *
 * @param blocks - The full ordered block list for the thread.
 * @param index  - The index of the block to test.
 * @param user   - The instance user whose own messages are excluded (TASK-462).
 * @returns true if any later block is from a non-user sender.
 */
export function isSuperseded(blocks: MessageBlock[], index: number, user: string = "alex"): boolean {
  for (let i = index + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block !== undefined && block.header.from !== user) {
      return true;
    }
  }
  return false;
}

/**
 * Derive the receipt state to render in the bubble footer tick cluster.
 *
 * Decision table:
 *   working + not superseded  -> "working"  (spin indicator, subsumes read)
 *   working + superseded      -> "read"     (agent replied; read is the honest residual)
 *   read                      -> "read"
 *   sent (or unknown)         -> "sent"
 *
 * @param block       - The message block.
 * @param superseded  - Whether a later non-alex block exists in the thread.
 * @returns The receipt state to render.
 */
export function bubbleReceiptState(
  block: MessageBlock,
  superseded: boolean
): "sent" | "read" | "working" {
  const status = block.header.status;
  if (status === "working") {
    return superseded ? "read" : "working";
  }
  if (status === "read") {
    return "read";
  }
  // "sent" and any unknown value -> sent
  return "sent";
}

/**
 * Age suffix for the working indicator label (Atlas fold, TASK-444 plan s6).
 *
 * A crashed agent never writes a later block, so a bare live indicator
 * would lie by omission indefinitely. When the working MESSAGE is older
 * than one hour, the label discloses its age: " - sent 3 hours ago".
 *
 * Deliberately phrased as SENT age, not working duration: the header
 * timestamp is the message time, not the flip time - claiming a work
 * duration we do not know would trade one lie for another. A true
 * working-since flip timestamp is a protocol follow-on.
 *
 * @param timestampIso - The block header timestamp (ISO string).
 * @param now          - The current instant (injected, never wall-clock in tests).
 * @returns "" when the message is an hour old or less; " - sent <distance> ago" otherwise.
 */
export function workingAgeSuffix(timestampIso: string, now: Date): string {
  const sentAt = new Date(timestampIso);
  const ageMs = now.getTime() - sentAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 60 * 60 * 1000) {
    return "";
  }
  return ` - sent ${formatDistance(sentAt, now, { addSuffix: true })}`;
}
