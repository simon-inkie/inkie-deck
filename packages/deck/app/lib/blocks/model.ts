/**
 * Pure TypeScript types for the message-block and decision-card model.
 * No IO, no fs, no rendering. The typed edge of the data-access seam.
 */

/** A single option in a decision card. */
export interface Option {
  key: string;
  label: string;
  detail: string;
}

/**
 * A parsed action card.
 * Known fields only - unknown fields live in rawMeta.
 * actionId maps from the "action-id" YAML key.
 */
export interface ActionCard {
  actionId: string;
  /** Optional priority string (e.g. "high", "low"). */
  priority?: string;
  /** Optional Linear / external ticket URL. */
  ticket?: string;
  /** ISO timestamp written by applyDone when the action is marked done. */
  done?: string;
  /** ISO timestamp written by applyDismiss when the action is dismissed. */
  dismissed?: string;
  /** Optional reason for dismissal (JSON-decoded string from dismiss-reason: meta key). */
  dismissReason?: string;
  /** Optional note added after done (JSON-decoded string from done-note: meta key). */
  doneNote?: string;
  /** ISO timestamp written by applySupersedeAction when the action is superseded. */
  superseded?: string;
  /** Optional note explaining the supersession (JSON-decoded from supersede-note: meta key). */
  supersedeNote?: string;
}

/**
 * A parsed decision card.
 * Known fields only - unknown fields (lean, blocking, etc.) live in rawMeta.
 * decisionId maps from the "decision-id" YAML key.
 */
export interface DecisionCard {
  decisionId: string;
  options: Option[];
  /** The selected answer key, if the card has been answered. */
  answer?: string;
  /** The applied answer key after writeback (e.g. "answered: B"). */
  answered?: string;
  /**
   * The user-authored text when the card was answered with the custom option C.
   * Parsed from the "custom-answer" YAML key (JSON-encoded in rawMeta).
   */
  customAnswer?: string;
  /** ISO timestamp written by applyDismissDecision when the decision is dismissed. */
  dismissed?: string;
  /** Optional reason for dismissal (JSON-decoded string from dismiss-reason: meta key). */
  dismissReason?: string;
  /** ISO timestamp written by applySupersedeDecision when the decision is superseded. */
  superseded?: string;
  /** Optional note explaining the supersession (JSON-decoded from supersede-note: meta key). */
  supersedeNote?: string;
}

/** Parsed block header fields. */
export interface BlockHeader {
  timestamp: string;
  from: string;
  /**
   * Message receipt status.
   * "sent"    - delivered, not yet read by the recipient.
   * "read"    - recipient has read the message (the read-flip per SYSTEM.md).
   * "working" - agent has picked up the message and is actively working on it.
   *             The working indicator clears visually once a later reply from
   *             the agent exists in the thread (superseded working -> read).
   */
  status: "sent" | "read" | "working";
  subject: string;
  /**
   * The header line EXACTLY as it was read, set ONLY when parseHeader failed.
   *
   * A header we cannot parse has no correct canonical form: every field we would
   * emit is a guess. serializeHeader therefore writes this back verbatim, making
   * a re-serialise a no-op rather than a lossy rewrite.
   *
   * Never set on the success path. If it were, a legitimate status flip
   * (sent -> read) would serialise the OLD line and the flip would never persist.
   */
  rawHeader?: string;
}

/**
 * A parsed inbox message block.
 *
 * rawMeta: the verbatim metadata region string (lines between header and first
 * blank line, or "" when none). Used for byte-level round-trip via serializeBlock.
 * NEVER replace rawMeta with zod-serialized output - that breaks round-trip fidelity.
 */
export interface MessageBlock {
  header: BlockHeader;
  /** Raw markdown body text (everything after the blank line up to the separator). */
  body: string;
  /** Present if the block is a valid decision card; absent for plain bubbles. */
  card?: DecisionCard;
  /** Present if the block is a valid action card; absent for plain bubbles and decision cards. */
  actionCard?: ActionCard;
  /**
   * Normalised Linear ticket identifier (e.g. "TASK-445"), if a valid ticket: meta line
   * is present on this block. Absent when the line is missing or the value is unrecognised.
   * The raw verbatim line is preserved in rawMeta; this field is the normalised form only.
   */
  ticket?: string;
  /** Verbatim metadata region for round-trip fidelity. "" when there is no metadata. */
  rawMeta: string;
  /** The full original raw block string, if available (used for exact round-trip testing). */
  rawBlock?: string;
}

/**
 * Result of applying an answer to a decision card.
 *
 * Two shapes:
 * - { answeredOriginal, replyBlock } when a new answer is applied.
 * - { alreadyAnswered: true, existingAnswer } when the card was already answered (idempotent no-op).
 */
export type AnswerResult =
  | { answeredOriginal: MessageBlock; replyBlock: MessageBlock }
  | { alreadyAnswered: true; existingAnswer: string }
  | { alreadyDismissed: true; existingDismissedAt: string }
  | { alreadySuperseded: true; existingSupersededAt: string };

/**
 * Result of applying a custom (user-authored) answer to a decision card.
 *
 * Two shapes:
 * - { answeredOriginal, replyBlock } when the custom answer is applied.
 * - { alreadyAnswered: true, existingAnswer } when the card was already answered (idempotent no-op).
 */
export type CustomAnswerResult =
  | { answeredOriginal: MessageBlock; replyBlock: MessageBlock }
  | { alreadyAnswered: true; existingAnswer: string }
  | { alreadyDismissed: true; existingDismissedAt: string }
  | { alreadySuperseded: true; existingSupersededAt: string };

/**
 * Result of applying applyDone to an action card.
 *
 * Three shapes:
 * - { markedDone: MessageBlock; doneAt: string } when a new done timestamp is applied.
 * - { alreadyDone: true; existingDoneAt: string } when the action was already done (idempotent no-op).
 * - { alreadyDismissed: true; existingDismissedAt: string } when dismissed: is present
 *   (mutual exclusion - no-op; a dismissed action is NOT done and must not report a done timestamp).
 * - { alreadySuperseded: true; existingSupersededAt: string } when superseded: is present
 *   (mutual exclusion - no-op; a superseded action is NOT done).
 */
export type DoneResult =
  | { markedDone: MessageBlock; doneAt: string }
  | { alreadyDone: true; existingDoneAt: string }
  | { alreadyDismissed: true; existingDismissedAt: string }
  | { alreadySuperseded: true; existingSupersededAt: string };

/**
 * Result of applying applyDismiss to an action card.
 *
 * Three shapes:
 * - { dismissedBlock: MessageBlock; dismissedAt: string; replyBlock?: MessageBlock } when newly dismissed.
 * - { alreadyDismissed: true; existingDismissedAt: string } when already dismissed (idempotent no-op).
 * - { alreadyDone: true } when done: is present (mutual exclusion - no-op).
 * - { alreadySuperseded: true; existingSupersededAt: string } when superseded: is present
 *   (mutual exclusion - no-op; a superseded action cannot be dismissed).
 */
export type DismissResult =
  | { dismissedBlock: MessageBlock; dismissedAt: string; replyBlock: MessageBlock }
  | { alreadyDismissed: true; existingDismissedAt: string }
  | { alreadyDone: true }
  | { alreadySuperseded: true; existingSupersededAt: string };

/**
 * Result of applying addDoneNote to an action card.
 *
 * Three shapes:
 * - { notedBlock: MessageBlock; replyBlock: MessageBlock } when note is applied.
 * - { alreadyNoted: true } when done-note: already present (idempotent no-op).
 * - { notDone: true } when done: is not present (invalid path - note requires done).
 */
export type DoneNoteResult =
  | { notedBlock: MessageBlock; replyBlock: MessageBlock }
  | { alreadyNoted: true }
  | { notDone: true };

/**
 * Result of pushing back a decision card.
 *
 * Two shapes:
 * - { pushedBackOriginal, pushBackBlock } when push-back is applied to an unresolved card.
 * - { alreadyResolved: true, existingState } when the card was already resolved (answered or pushed back).
 *
 * CARD-03: push-back flips the card to answered: pushback and emits a distinct push-back reply block.
 * CARD-04: idempotent no-op when the card is already resolved (mutual exclusion with answer).
 *
 * The alreadyResolved variant also covers a card resolved by dismissal or
 * supersession: existingState carries the resolution ("dismissed" / "superseded")
 * so a dismissed or superseded decision can never be pushed back.
 */
export type PushBackResult =
  | { pushedBackOriginal: MessageBlock; pushBackBlock: MessageBlock }
  | { alreadyResolved: true; existingState: string };

/**
 * Result of applying applyDismissDecision to a decision card.
 *
 * Mirrors the action-card DismissResult mechanics (dismissed: ISO + optional
 * dismiss-reason: JSON + a dismissed-reply block), but a decision's terminal
 * states are answered / superseded (not done), so the mutual-exclusion no-ops
 * differ:
 * - { dismissedBlock; dismissedAt; replyBlock } when newly dismissed.
 * - { alreadyDismissed: true; existingDismissedAt } when already dismissed (idempotent).
 * - { alreadyAnswered: true; existingAnswer } when answered: is present (mutual exclusion).
 * - { alreadySuperseded: true; existingSupersededAt } when superseded: is present (mutual exclusion).
 */
export type DismissDecisionResult =
  | { dismissedBlock: MessageBlock; dismissedAt: string; replyBlock: MessageBlock }
  | { alreadyDismissed: true; existingDismissedAt: string }
  | { alreadyAnswered: true; existingAnswer: string }
  | { alreadySuperseded: true; existingSupersededAt: string };

/**
 * Result of applying applySupersedeAction to an action card.
 *
 * Writes superseded: ISO + optional supersede-note: JSON and emits a
 * superseded-reply block. An action's terminal states are done / dismissed:
 * - { supersededBlock; supersededAt; replyBlock } when newly superseded.
 * - { alreadySuperseded: true; existingSupersededAt } when already superseded (idempotent).
 * - { alreadyDone: true } when done: is present (mutual exclusion).
 * - { alreadyDismissed: true; existingDismissedAt } when dismissed: is present (mutual exclusion).
 */
export type SupersedeActionResult =
  | { supersededBlock: MessageBlock; supersededAt: string; replyBlock: MessageBlock }
  | { alreadySuperseded: true; existingSupersededAt: string }
  | { alreadyDone: true }
  | { alreadyDismissed: true; existingDismissedAt: string };

/**
 * Result of applying applySupersedeDecision to a decision card.
 *
 * Writes superseded: ISO + optional supersede-note: JSON and emits a
 * superseded-reply block. A decision's terminal states are answered / dismissed:
 * - { supersededBlock; supersededAt; replyBlock } when newly superseded.
 * - { alreadySuperseded: true; existingSupersededAt } when already superseded (idempotent).
 * - { alreadyAnswered: true; existingAnswer } when answered: is present (mutual exclusion).
 * - { alreadyDismissed: true; existingDismissedAt } when dismissed: is present (mutual exclusion).
 */
export type SupersedeDecisionResult =
  | { supersededBlock: MessageBlock; supersededAt: string; replyBlock: MessageBlock }
  | { alreadySuperseded: true; existingSupersededAt: string }
  | { alreadyAnswered: true; existingAnswer: string }
  | { alreadyDismissed: true; existingDismissedAt: string };
