/**
 * scroll-follow.ts - scroll-to-latest decision logic (TASK-454).
 *
 * Pure helpers behind the thread view's follow-bottom behaviour. The 455
 * review pin is load-bearing here: any follow-bottom feature must
 * distinguish "user at bottom" from "user scrolled up" before it may move
 * the viewport. shouldFollow encodes that as a truth table; the route wires
 * it to a scroll-position ref and an effect keyed on real content change.
 *
 * Client-pure module, no env/fs (FND-02). ASCII only (FND-05).
 */

/**
 * Within this many pixels of the bottom counts as "at bottom". Absorbs small
 * layout shifts (late-loading images, font swap) without losing the follow.
 */
export const NEAR_BOTTOM_THRESHOLD_PX = 150;

/**
 * True when the scroll position is at (or near) the bottom of the container.
 *
 * @param scrollTop - element.scrollTop at measurement time.
 * @param scrollHeight - element.scrollHeight.
 * @param clientHeight - element.clientHeight.
 * @param threshold - distance from true bottom still counting as "at bottom".
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export interface FollowInput {
  /** First run after mount (nothing rendered to the user yet). */
  isInitial: boolean;
  /** location.hash present - the deep-link effect owns the scroll instead. */
  hasHash: boolean;
  /** Was the user at/near the bottom when the new content arrived? */
  wasNearBottom: boolean;
}

/**
 * Whether the thread view may move the viewport to the newest message.
 *
 * - initial + hash: false - the needs-you deep-link scroll wins.
 * - initial + no hash: true - land on the latest message, instant.
 * - update + user near bottom: true - follow the conversation, smooth.
 * - update + user scrolled up: false - NEVER yank him out of history.
 */
export function shouldFollow({ isInitial, hasHash, wasNearBottom }: FollowInput): boolean {
  if (isInitial) return !hasHash;
  return wasNearBottom;
}
