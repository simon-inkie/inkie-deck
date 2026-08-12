/**
 * card-reply-link.ts - the one place that knows the shape of a "reply to this
 * card, over on its own thread" deep link, and the rule for when landing on
 * that link is allowed to put the composer into card-reply mode.
 *
 * WHY THIS MODULE EXISTS. The link has a producer (the Cards tab, which builds
 * it in onWriteOwn) and a consumer (the thread route, which seeds
 * respondingToDecisionId from it). They live in different route modules, and a
 * route module cannot import another route module here without dragging server
 * imports into the client bundle. Left to themselves the two ends drift: the
 * bug this fixes was exactly a producer sending state the consumer never read.
 * Keeping the param names, the href shape and the validation predicate together
 * means a change to one end cannot silently miss the other.
 *
 * Pure module: no fs, no .server imports, no React (FND-02). Safe on both
 * sides of the seam and unit-testable without a router.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { isDecisionResolved } from "./queue-derive";

/**
 * Loader input. Extends the thread's read window back far enough to include
 * the target card (TASK-469 windowing), and the scroll effect reads it too.
 * SERVER-VISIBLE and long-lived: it must stay in the URL for as long as the
 * thread is open, or the next revalidation shrinks the window back to the tail
 * and unmounts the card being answered.
 */
export const ANCHOR_PARAM = "anchor";

/**
 * Card-reply seed. CLIENT-ONLY and consume-once: the thread route reads it on
 * mount, seeds respondingToDecisionId from it, and strips it from the URL. It
 * is deliberately NOT the anchor param - see the long comment at the seeding
 * effect in threads.$agent.tsx for why the two cannot be the same param.
 */
export const REPLY_PARAM = "reply";

/**
 * Build the href for "OR write something..." on a card that is NOT rendered in
 * the thread it belongs to (i.e. the Cards tab).
 *
 * Carries all three signals, which are three different jobs:
 *   - ?anchor= so the loader window reaches back to the card
 *   - ?reply=  so the composer opens in card-reply mode for that card
 *   - #hash    so the card is scrolled into view
 */
export function buildCardReplyHref(agent: string, decisionId: string): string {
  const params = new URLSearchParams();
  params.set(ANCHOR_PARAM, decisionId);
  params.set(REPLY_PARAM, decisionId);
  return `/threads/${agent}?${params.toString()}#${encodeURIComponent(decisionId)}`;
}

/** Minimal structural shape of a loaded block, as both MessageBlock and the
 *  loader-serialised window block satisfy it. */
export interface CardReplyCandidateBlock {
  card?:
    | {
        decisionId: string;
        answered?: string | undefined;
        dismissed?: string | undefined;
        superseded?: string | undefined;
      }
    | undefined;
}

/**
 * May a ?reply=<decisionId> seed be applied against these blocks?
 *
 * A query param is user input, not a fact: the id is only honoured when THIS
 * thread's loaded blocks actually carry that decision card AND the card is
 * still open. A stale id, an already-answered/dismissed/superseded card, an id
 * belonging to another agent, or a hand-edited URL all fall through to the
 * ordinary composer rather than forcing the user into reply mode against a
 * card that no longer wants an answer.
 */
export function canSeedCardReply(
  blocks: readonly CardReplyCandidateBlock[],
  decisionId: string | null | undefined,
): boolean {
  if (decisionId === null || decisionId === undefined || decisionId === "") {
    return false;
  }
  const match = blocks.find((b) => b.card?.decisionId === decisionId);
  if (match?.card === undefined) return false;
  return !isDecisionResolved(match.card);
}
