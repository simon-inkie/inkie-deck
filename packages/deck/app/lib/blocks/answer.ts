/**
 * applyAnswer: Flip a decision card to its answered state and emit a structured reply block.
 * applyPushBack: Flip a decision card to pushed-back state and emit a distinct push-back reply block.
 *
 * Push-back contract: applyPushBack emits a distinct push-back block, not a non-answer.
 * Idempotency contract: both functions are idempotent no-ops when the card is already resolved.
 *   answered-then-pushback and pushback-then-answer are both no-ops (mutual exclusion).
 *   Never produces two conflicting blocks.
 *
 * Strategy:
 * - Check rawMeta for an existing "answered:" line (idempotent guard).
 * - If present: return the already-resolved variant - no new reply block.
 * - If absent: targeted line-edit on rawMeta (preserves all other lines).
 *   Construct a new reply MessageBlock with the appropriate marker in its metadata region.
 *
 * Single source of truth: push-back tokens are exported const values so the renderer
 * and Phase 3 queue import them rather than re-typing literals.
 *
 * Ref: RESEARCH.md section B "Answer writeback + answered-flip + idempotency", T-01-05.
 * Ref: PLAN.md assumptions_log (pinned push-back token decision).
 */
import type {
  MessageBlock,
  AnswerResult,
  CustomAnswerResult,
  PushBackResult,
  DoneResult,
  DismissResult,
  DoneNoteResult,
  DismissDecisionResult,
  SupersedeActionResult,
  SupersedeDecisionResult,
} from "./model.js";

// ---------------------------------------------------------------------------
// Push-back token constants
// ---------------------------------------------------------------------------

/**
 * The resolution value written to the original card's rawMeta when pushed back.
 * Written as: "answered: pushback"
 * The existing answered: guard catches this, giving symmetric mutual-exclusion
 * with applyAnswer - zero new guard regex needed.
 */
export const PUSHBACK_RESOLUTION = "pushback";

/**
 * The reply-marker line written to the push-back reply block's rawMeta.
 * Written as: "push-back: true"
 * Distinguishes the push-back reply from a regular answer reply.
 */
export const PUSHBACK_REPLY_MARKER = "push-back: true";

// ---------------------------------------------------------------------------
// Custom-answer token constants (single source of truth)
// ---------------------------------------------------------------------------

/**
 * The resolution value written to the original card's rawMeta when the user
 * writes their own answer instead of tapping an option.
 * Written as: "answered: custom"
 *
 * A letter key cannot carry this: it used to be hardcoded "C", which collides
 * with a real option C on any card offering three or more options. The
 * collision ran both ways - a written answer was indistinguishable from a tap
 * on C, and a genuine tap on C rendered as a custom answer with no text, so
 * the record showed no option chosen at all. "answered: pushback" already
 * proved a non-letter resolution is the established shape here, and the parser
 * accepts any non-empty string, so nothing schema-side moves.
 *
 * A non-letter sentinel cannot collide with A/B/C by CONVENTION, and
 * convention is not a guarantee: the parser accepts ANY non-empty string as an
 * option key, so nothing stops a card author writing `key: custom`. The
 * guarantee lives in isCustomAnswer below, which requires the custom-answer
 * TEXT to be present and not merely the marker.
 */
export const CUSTOM_ANSWER_RESOLUTION = "custom";

/**
 * The pre-fix resolution value. Historical records are never rewritten, so the
 * reader below still has to recognise them - but only in company with a
 * custom-answer: field, which is what keeps a genuine historical tap on option
 * C out of the custom arm.
 */
const LEGACY_CUSTOM_ANSWER_RESOLUTION = "C";

/**
 * Does this card's answered state mean "the user wrote their own answer"?
 *
 * Requires BOTH a marker (the current sentinel, or the legacy letter for
 * records already on disk) AND the custom-answer text. Both halves are
 * load-bearing:
 *
 *   - the text alone is not enough, or a normal tap on a card carrying
 *     leftover custom-answer text would read as a written answer;
 *   - the marker alone is not enough, which is what keeps out both a genuine
 *     tap on option C and a tap on an option someone keyed `custom`.
 */
export function isCustomAnswer(card: {
  answered?: string;
  customAnswer?: string;
}): boolean {
  // A WRITTEN ANSWER ALWAYS HAS TEXT. The thread route's schema enforces
  // `text: z.string().trim().min(1)` and applyCustomAnswer writes that text as
  // the custom-answer: sibling, so this is not a heuristic. Requiring it FIRST
  // is what makes "cannot collide with an option key" true by construction
  // rather than by convention: a card author CAN key an option `custom`, and a
  // tap on that option carries no sibling, so it is correctly not a written
  // answer.
  if (card.customAnswer === undefined) return false;
  // Either marker, given the text is there. The legacy letter is accepted only
  // for records already on disk; a genuine tap on option C has no sibling and
  // was excluded above.
  return (
    card.answered === CUSTOM_ANSWER_RESOLUTION ||
    card.answered === LEGACY_CUSTOM_ANSWER_RESOLUTION
  );
}

// ---------------------------------------------------------------------------
// Meta-line helpers
// ---------------------------------------------------------------------------

/**
 * Find a rawMeta line carrying a NON-EMPTY value for the given key.
 *
 * An empty placeholder line ("answered:" / "answered:   ") is NOT a
 * resolution. Some agents author cards with pre-written empty fields
 * (answered: / custom-answer: as a template); the old loose guard matched
 * those placeholders and turned every tap into a silent alreadyAnswered
 * no-op - the card could never be resolved from the UI. Parse already
 * treats an empty value as undefined; this makes the write side agree
 * with the read side.
 */
function findMetaValueLine(lines: string[], key: string): string | undefined {
  return lines.find((l) => new RegExp(`^${key}:\\s*\\S`).test(l));
}

/**
 * Read the trimmed value of a NON-EMPTY meta line for the given key, or
 * undefined when no such line exists. Thin wrapper over findMetaValueLine used
 * by the cross-state mutual-exclusion guards so each guard reads as one line.
 */
function metaValue(lines: string[], key: string): string | undefined {
  const line = findMetaValueLine(lines, key);
  if (line === undefined) return undefined;
  return line.replace(new RegExp(`^${key}:\\s*`), "").trim();
}

/**
 * Write "key: value" into rawMeta via targeted line edit: overwrite an empty
 * placeholder line in place when one exists (appending a duplicate key would
 * poison the next YAML parse of the block), otherwise append.
 */
function setMetaLine(rawMeta: string, key: string, value: string): string {
  const lines = rawMeta.split("\n");
  const placeholderIdx = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (placeholderIdx !== -1) {
    lines[placeholderIdx] = `${key}: ${value}`;
    return lines.join("\n");
  }
  return rawMeta ? `${rawMeta}\n${key}: ${value}` : `${key}: ${value}`;
}

// ---------------------------------------------------------------------------
// applyAnswer
// ---------------------------------------------------------------------------

/**
 * Apply an answer key to a decision card block.
 *
 * If the block's rawMeta already has an "answered:" line, returns the existing answer
 * without modification.
 *
 * Otherwise, returns:
 * - answeredOriginal: the original block with "answered: <key>" appended to rawMeta
 * - replyBlock: a new MessageBlock with "answer: <key>" in its metadata region
 */
export function applyAnswer(originalBlock: MessageBlock, key: string, from: string = "alex"): AnswerResult {
  const rawMeta = originalBlock.rawMeta;

  // Check for existing answered: line (non-empty value only - an
  // empty placeholder from a card template is unanswered, see helpers above)
  const lines = rawMeta.split("\n");
  const existingAnsweredLine = findMetaValueLine(lines, "answered");

  if (existingAnsweredLine) {
    // Already answered - idempotent no-op
    const existingAnswer = existingAnsweredLine.replace(/^answered:\s*/, "").trim();
    return { alreadyAnswered: true, existingAnswer };
  }

  // Cross-state mutual exclusion (Thread C): a dismissed or superseded decision
  // is terminal and must never be answerable. Without these guards the new
  // dismiss/supersede write paths would leave a hole where a resolved card
  // could still be answered.
  const dismissedAt = metaValue(lines, "dismissed");
  if (dismissedAt !== undefined) {
    return { alreadyDismissed: true, existingDismissedAt: dismissedAt };
  }
  const supersededAt = metaValue(lines, "superseded");
  if (supersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt: supersededAt };
  }

  // Not yet answered - apply the answer
  // Targeted line edit: fill the empty placeholder in place or append
  // (never re-serialize the entire object)
  const newRawMeta = setMetaLine(rawMeta, "answered", key);

  const answeredOriginal: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  // Construct the reply block
  // The reply carries "answer: <key>" in its metadata region.
  // Header: from alex, status sent, subject derived from the original card.
  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: decision";

  // Generate a timestamp for the reply (current UTC time, ISO-8601)
  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyRawMeta = `answer: ${key}`;

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: `Answered: ${key}`,
    rawMeta: replyRawMeta,
    card: undefined,
  };

  return { answeredOriginal, replyBlock };
}

// ---------------------------------------------------------------------------
// applyPushBack
// ---------------------------------------------------------------------------

/**
 * Apply a push-back to a decision card block.
 *
 * If the block's rawMeta already has an "answered:" line (including "answered: pushback"),
 * returns the existing resolution without modification.
 * This gives mutual exclusion: an answered card cannot be pushed back and vice versa.
 *
 * Otherwise, returns:
 * - pushedBackOriginal: the original block with "answered: pushback" appended to rawMeta
 * - pushBackBlock: a new MessageBlock with "push-back: true" in its metadata region
 *
 * The optional note parameter provides the body for the push-back reply block.
 * If absent, a plain ASCII default is used.
 */
export function applyPushBack(originalBlock: MessageBlock, note?: string, from: string = "alex"): PushBackResult {
  const rawMeta = originalBlock.rawMeta;

  // Check for existing answered: line (catches both answered:B and
  // answered:pushback; empty placeholders do not count - see helpers above)
  const lines = rawMeta.split("\n");
  const existingAnsweredLine = findMetaValueLine(lines, "answered");

  if (existingAnsweredLine) {
    // Already resolved (answered or pushed back) - idempotent no-op
    const existingState = existingAnsweredLine.replace(/^answered:\s*/, "").trim();
    return { alreadyResolved: true, existingState };
  }

  // Cross-state mutual exclusion (Thread C): a dismissed or superseded decision
  // is already resolved and cannot be pushed back. Reuses the generic
  // alreadyResolved shape (existingState = the resolution) so the existing
  // idempotency guard covers all three terminal states with one variant.
  const dismissedAt = metaValue(lines, "dismissed");
  if (dismissedAt !== undefined) {
    return { alreadyResolved: true, existingState: "dismissed" };
  }
  const supersededAt = metaValue(lines, "superseded");
  if (supersededAt !== undefined) {
    return { alreadyResolved: true, existingState: "superseded" };
  }

  // Not yet resolved - apply the push-back
  // Targeted line edit: fill the empty placeholder in place or append
  const newRawMeta = setMetaLine(rawMeta, "answered", PUSHBACK_RESOLUTION);

  const pushedBackOriginal: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  // Construct the push-back reply block
  // Distinct from a regular answer reply: rawMeta carries "push-back: true"
  // Header: from alex, status sent, subject derived from the original card.
  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: decision";

  // Generate a timestamp for the reply (current UTC time, ISO-8601)
  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const pushBackBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: note ?? "Pushed back",
    rawMeta: PUSHBACK_REPLY_MARKER,
    card: undefined,
  };

  return { pushedBackOriginal, pushBackBlock };
}

// ---------------------------------------------------------------------------
// applyCustomAnswer
// ---------------------------------------------------------------------------

/**
 * Apply a user-authored custom answer to a decision card block.
 *
 * If the block's rawMeta already has an "answered:" line, returns the existing answer
 * without modification. This gives symmetric mutual-exclusion
 * with applyAnswer and applyPushBack: an already-resolved card is a no-op.
 *
 * Otherwise, returns:
 * - answeredOriginal: the original block with "answered: custom" and "custom-answer: <json>"
 *   appended to rawMeta. The text is JSON-encoded so arbitrary content (colons, quotes,
 *   newlines) stays valid YAML and round-trips cleanly.
 * - replyBlock: a new MessageBlock with "answer: custom" in its metadata region and the
 *   user-authored text as the body.
 */
export function applyCustomAnswer(originalBlock: MessageBlock, text: string, from: string = "alex"): CustomAnswerResult {
  const rawMeta = originalBlock.rawMeta;

  // Check for existing answered: line (mutual exclusion with answer
  // + push-back; empty placeholders do not count - see helpers above)
  const lines = rawMeta.split("\n");
  const existingAnsweredLine = findMetaValueLine(lines, "answered");

  if (existingAnsweredLine) {
    // Already answered - idempotent no-op
    const existingAnswer = existingAnsweredLine.replace(/^answered:\s*/, "").trim();
    return { alreadyAnswered: true, existingAnswer };
  }

  // Cross-state mutual exclusion (Thread C): dismissed or superseded is terminal.
  const dismissedAt = metaValue(lines, "dismissed");
  if (dismissedAt !== undefined) {
    return { alreadyDismissed: true, existingDismissedAt: dismissedAt };
  }
  const supersededAt = metaValue(lines, "superseded");
  if (supersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt: supersededAt };
  }

  // Not yet answered - apply the custom answer.
  // Write "answered: custom" and "custom-answer: <json>" via targeted line edits
  // (placeholders filled in place, else appended). JSON.stringify ensures
  // colons, quotes, newlines, and backslashes are safe in YAML.
  const jsonText = JSON.stringify(text);
  const newRawMeta = setMetaLine(
    setMetaLine(rawMeta, "answered", CUSTOM_ANSWER_RESOLUTION),
    "custom-answer",
    jsonText
  );

  const answeredOriginal: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  // Construct the reply block.
  // The reply carries "answer: custom" in its metadata region and the user text as body.
  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: decision";

  // Generate a timestamp for the reply (current UTC time, ISO-8601)
  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: text,
    rawMeta: `answer: ${CUSTOM_ANSWER_RESOLUTION}`,
    card: undefined,
  };

  return { answeredOriginal, replyBlock };
}

// ---------------------------------------------------------------------------
// applyDone
// ---------------------------------------------------------------------------

/**
 * Apply a done timestamp to an action card block.
 *
 * If the block's rawMeta already has a "done:" line, returns the existing
 * done timestamp without modification (idempotent no-op).
 *
 * Otherwise, returns:
 * - markedDone: the original block with "done: <ISO>" appended to rawMeta
 *   via the same targeted-line-edit discipline as applyAnswer. Fence-bounded:
 *   only the rawMeta region is touched; body and other rawMeta lines are byte-identical.
 * - doneAt: the ISO timestamp that was written.
 *
 * Decoy safety: a "done:" substring inside the body is NOT treated as done state.
 * The guard regex only matches rawMeta lines (the function receives a MessageBlock
 * whose rawMeta is already separated from the body by the parser).
 *
 * @param originalBlock - The MessageBlock containing the action card.
 * @param isoNow - ISO-8601 timestamp to write as the done value. Defaults to now.
 * @returns DoneResult
 */
export function applyDone(originalBlock: MessageBlock, isoNow?: string): DoneResult {
  const rawMeta = originalBlock.rawMeta;

  // Idempotent guard: check for existing "done:" line in rawMeta only
  // (non-empty value only - empty template placeholders do not count).
  const lines = rawMeta.split("\n");
  const existingDoneLine = findMetaValueLine(lines, "done");

  if (existingDoneLine) {
    const existingDoneAt = existingDoneLine.replace(/^done:\s*/, "").trim();
    return { alreadyDone: true, existingDoneAt };
  }

  // Mutual exclusion: if dismissed: is present, done is a no-op.
  // Honest shape (manager-review fix): a dismissed action is NOT done - report
  // alreadyDismissed with the dismissed timestamp, never a fake existingDoneAt.
  const existingDismissedLine = findMetaValueLine(lines, "dismissed");
  if (existingDismissedLine) {
    const existingDismissedAt = existingDismissedLine.replace(/^dismissed:\s*/, "").trim();
    return { alreadyDismissed: true, existingDismissedAt };
  }

  // Mutual exclusion (Thread C): a superseded action is NOT done.
  const supersededAt = metaValue(lines, "superseded");
  if (supersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt: supersededAt };
  }

  // Not yet done - write "done: <ISO>" via targeted line edit.
  const doneAt = isoNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const newRawMeta = setMetaLine(rawMeta, "done", doneAt);

  const markedDone: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  return { markedDone, doneAt };
}

// ---------------------------------------------------------------------------
// applyDismiss
// ---------------------------------------------------------------------------

/**
 * Dismiss an action card with an optional reason.
 *
 * Idempotent: if dismissed: is already present, returns alreadyDismissed.
 * Mutual exclusion: if done: is present, returns alreadyDone (cannot dismiss a done action).
 *
 * Appends to rawMeta via targeted line edit (same discipline as applyDone):
 *   dismissed: <ISO>
 *   dismiss-reason: <JSON-encoded string>  (only when reason is non-empty)
 *
 * Emits a reply block with rawMeta "dismissed-reply: true" and body = reason
 * (or "Dismissed" when reason is absent or empty).
 *
 * @param originalBlock - The MessageBlock containing the action card.
 * @param reason - Optional dismiss reason (plain string; JSON-encoded in rawMeta).
 * @param isoNow - ISO-8601 timestamp to write. Defaults to now.
 * @returns DismissResult
 */
export function applyDismiss(originalBlock: MessageBlock, reason?: string, isoNow?: string, from: string = "alex"): DismissResult {
  const rawMeta = originalBlock.rawMeta;
  const lines = rawMeta.split("\n");

  // Mutual exclusion: if done: is present, cannot dismiss
  // (non-empty value only - empty template placeholders do not count).
  const existingDoneLine = findMetaValueLine(lines, "done");
  if (existingDoneLine) {
    return { alreadyDone: true };
  }

  // Mutual exclusion (Thread C): a superseded action cannot be dismissed.
  const supersededAt = metaValue(lines, "superseded");
  if (supersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt: supersededAt };
  }

  // Idempotent guard: if dismissed: is already present, no-op.
  const existingDismissedLine = findMetaValueLine(lines, "dismissed");
  if (existingDismissedLine) {
    const existingDismissedAt = existingDismissedLine.replace(/^dismissed:\s*/, "").trim();
    return { alreadyDismissed: true, existingDismissedAt };
  }

  // Not yet dismissed - write "dismissed: <ISO>" and optionally "dismiss-reason: <json>".
  const dismissedAt = isoNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let newRawMeta = setMetaLine(rawMeta, "dismissed", dismissedAt);

  const trimmedReason = reason?.trim() ?? "";
  if (trimmedReason.length > 0) {
    newRawMeta = setMetaLine(newRawMeta, "dismiss-reason", JSON.stringify(trimmedReason));
  }

  const dismissedBlock: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  // Construct the reply block.
  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: action";

  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: trimmedReason.length > 0 ? trimmedReason : "Dismissed",
    rawMeta: "dismissed-reply: true",
    card: undefined,
  };

  return { dismissedBlock, dismissedAt, replyBlock };
}

// ---------------------------------------------------------------------------
// applyDoneNote
// ---------------------------------------------------------------------------

/**
 * Append a note to an already-done action card.
 *
 * Only valid after done: is present. Returns notDone if done: is absent.
 * Idempotent: if done-note: is already present, returns alreadyNoted.
 *
 * Appends to rawMeta via targeted line edit:
 *   done-note: <JSON-encoded string>
 *
 * Emits a reply block with rawMeta "done-note: true" and body = note.
 *
 * @param originalBlock - The MessageBlock containing the action card (must be done).
 * @param note - The note text (non-empty).
 * @param isoNow - Optional ISO timestamp for the reply block. Defaults to now.
 * @returns DoneNoteResult
 */
export function applyDoneNote(originalBlock: MessageBlock, note: string, isoNow?: string, from: string = "alex"): DoneNoteResult {
  const rawMeta = originalBlock.rawMeta;
  const lines = rawMeta.split("\n");

  // Requires done: to be present (non-empty value only).
  const existingDoneLine = findMetaValueLine(lines, "done");
  if (!existingDoneLine) {
    return { notDone: true };
  }

  // Idempotent guard: if done-note: is already present, no-op.
  const existingNoteLine = findMetaValueLine(lines, "done-note");
  if (existingNoteLine) {
    return { alreadyNoted: true };
  }

  // Write "done-note: <json>" via targeted line edit.
  const trimmedNote = note.trim();
  const newRawMeta = setMetaLine(rawMeta, "done-note", JSON.stringify(trimmedNote));

  const notedBlock: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  // Construct the reply block.
  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: action";

  const replyTimestamp = isoNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: trimmedNote,
    rawMeta: "done-note: true",
    card: undefined,
  };

  return { notedBlock, replyBlock };
}

// ---------------------------------------------------------------------------
// applyDismissDecision (Thread C: decision cards gain a dismiss path)
// ---------------------------------------------------------------------------

/**
 * Dismiss a decision card with an optional reason.
 *
 * Mirrors the action-card applyDismiss mechanics (targeted rawMeta line edits,
 * JSON-encoded reason, a dismissed-reply block), but a decision's terminal
 * states are answered / superseded, so the mutual-exclusion set differs:
 * - answered: present  -> alreadyAnswered (cannot dismiss a resolved decision)
 * - superseded: present -> alreadySuperseded (mutual exclusion)
 * - dismissed: present  -> alreadyDismissed (idempotent no-op)
 *
 * @param originalBlock - The MessageBlock containing the decision card.
 * @param reason - Optional dismiss reason (plain string; JSON-encoded in rawMeta).
 * @param isoNow - ISO-8601 timestamp to write. Defaults to now.
 * @param from - Reply author identity. Defaults to "alex".
 * @returns DismissDecisionResult
 */
export function applyDismissDecision(
  originalBlock: MessageBlock,
  reason?: string,
  isoNow?: string,
  from: string = "alex"
): DismissDecisionResult {
  const rawMeta = originalBlock.rawMeta;
  const lines = rawMeta.split("\n");

  // Mutual exclusion: an answered (or pushed-back) decision cannot be dismissed.
  const existingAnswer = metaValue(lines, "answered");
  if (existingAnswer !== undefined) {
    return { alreadyAnswered: true, existingAnswer };
  }

  // Mutual exclusion: a superseded decision cannot be dismissed.
  const existingSupersededAt = metaValue(lines, "superseded");
  if (existingSupersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt };
  }

  // Idempotent guard: if dismissed: is already present, no-op.
  const existingDismissedAt = metaValue(lines, "dismissed");
  if (existingDismissedAt !== undefined) {
    return { alreadyDismissed: true, existingDismissedAt };
  }

  // Not yet dismissed - write "dismissed: <ISO>" and optionally "dismiss-reason: <json>".
  const dismissedAt = isoNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let newRawMeta = setMetaLine(rawMeta, "dismissed", dismissedAt);

  const trimmedReason = reason?.trim() ?? "";
  if (trimmedReason.length > 0) {
    newRawMeta = setMetaLine(newRawMeta, "dismiss-reason", JSON.stringify(trimmedReason));
  }

  const dismissedBlock: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : "Re: decision";

  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: trimmedReason.length > 0 ? trimmedReason : "Dismissed",
    rawMeta: "dismissed-reply: true",
    card: undefined,
  };

  return { dismissedBlock, dismissedAt, replyBlock };
}

// ---------------------------------------------------------------------------
// applySupersedeAction (Thread C: action cards gain a superseded state)
// ---------------------------------------------------------------------------

/**
 * Supersede an action card with an optional note.
 *
 * "Superseded" is a terminal state distinct from done/dismissed: the action is
 * no longer relevant because a newer action replaced it. Same rawMeta line-edit
 * discipline as applyDismiss; writes superseded: <ISO> + optional
 * supersede-note: <json>, emits a superseded-reply block.
 *
 * An action's other terminal states are done / dismissed:
 * - done: present      -> alreadyDone (mutual exclusion)
 * - dismissed: present -> alreadyDismissed (mutual exclusion)
 * - superseded: present -> alreadySuperseded (idempotent no-op)
 *
 * @param originalBlock - The MessageBlock containing the action card.
 * @param note - Optional supersede note (plain string; JSON-encoded in rawMeta).
 * @param isoNow - ISO-8601 timestamp to write. Defaults to now.
 * @param from - Reply author identity. Defaults to "alex".
 * @returns SupersedeActionResult
 */
export function applySupersedeAction(
  originalBlock: MessageBlock,
  note?: string,
  isoNow?: string,
  from: string = "alex"
): SupersedeActionResult {
  const rawMeta = originalBlock.rawMeta;
  const lines = rawMeta.split("\n");

  // Mutual exclusion: a done action cannot be superseded.
  const existingDoneLine = findMetaValueLine(lines, "done");
  if (existingDoneLine) {
    return { alreadyDone: true };
  }

  // Mutual exclusion: a dismissed action cannot be superseded.
  const existingDismissedAt = metaValue(lines, "dismissed");
  if (existingDismissedAt !== undefined) {
    return { alreadyDismissed: true, existingDismissedAt };
  }

  // Idempotent guard: if superseded: is already present, no-op.
  const existingSupersededAt = metaValue(lines, "superseded");
  if (existingSupersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt };
  }

  return supersedeCommon(originalBlock, note, isoNow, from, "Re: action");
}

// ---------------------------------------------------------------------------
// applySupersedeDecision (Thread C: decision cards gain a superseded state)
// ---------------------------------------------------------------------------

/**
 * Supersede a decision card with an optional note.
 *
 * Same mechanics as applySupersedeAction; a decision's other terminal states
 * are answered / dismissed:
 * - answered: present   -> alreadyAnswered (mutual exclusion)
 * - dismissed: present  -> alreadyDismissed (mutual exclusion)
 * - superseded: present -> alreadySuperseded (idempotent no-op)
 *
 * @param originalBlock - The MessageBlock containing the decision card.
 * @param note - Optional supersede note (plain string; JSON-encoded in rawMeta).
 * @param isoNow - ISO-8601 timestamp to write. Defaults to now.
 * @param from - Reply author identity. Defaults to "alex".
 * @returns SupersedeDecisionResult
 */
export function applySupersedeDecision(
  originalBlock: MessageBlock,
  note?: string,
  isoNow?: string,
  from: string = "alex"
): SupersedeDecisionResult {
  const rawMeta = originalBlock.rawMeta;
  const lines = rawMeta.split("\n");

  // Mutual exclusion: an answered (or pushed-back) decision cannot be superseded.
  const existingAnswer = metaValue(lines, "answered");
  if (existingAnswer !== undefined) {
    return { alreadyAnswered: true, existingAnswer };
  }

  // Mutual exclusion: a dismissed decision cannot be superseded.
  const existingDismissedAt = metaValue(lines, "dismissed");
  if (existingDismissedAt !== undefined) {
    return { alreadyDismissed: true, existingDismissedAt };
  }

  // Idempotent guard: if superseded: is already present, no-op.
  const existingSupersededAt = metaValue(lines, "superseded");
  if (existingSupersededAt !== undefined) {
    return { alreadySuperseded: true, existingSupersededAt };
  }

  return supersedeCommon(originalBlock, note, isoNow, from, "Re: decision");
}

/**
 * Shared write-and-reply mechanics for supersede on both card types. The
 * per-type guards live in the callers above (their mutual-exclusion sets
 * differ); by the time this runs the block is known to be supersedable, so
 * this only writes superseded: + supersede-note: and builds the reply. The
 * success shape is identical for both card types, so both result unions accept it.
 */
function supersedeCommon(
  originalBlock: MessageBlock,
  note: string | undefined,
  isoNow: string | undefined,
  from: string,
  replySubjectFallback: string
): { supersededBlock: MessageBlock; supersededAt: string; replyBlock: MessageBlock } {
  const supersededAt = isoNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let newRawMeta = setMetaLine(originalBlock.rawMeta, "superseded", supersededAt);

  const trimmedNote = note?.trim() ?? "";
  if (trimmedNote.length > 0) {
    newRawMeta = setMetaLine(newRawMeta, "supersede-note", JSON.stringify(trimmedNote));
  }

  const supersededBlock: MessageBlock = {
    ...originalBlock,
    rawMeta: newRawMeta,
  };

  const replySubject = originalBlock.header.subject
    ? `Re: ${originalBlock.header.subject}`
    : replySubjectFallback;

  const replyTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const replyBlock: MessageBlock = {
    header: {
      timestamp: replyTimestamp,
      from,
      status: "sent",
      subject: replySubject,
    },
    body: trimmedNote.length > 0 ? trimmedNote : "Superseded",
    rawMeta: "superseded-reply: true",
    card: undefined,
  };

  return { supersededBlock, supersededAt, replyBlock };
}
