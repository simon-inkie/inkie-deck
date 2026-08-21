/**
 * queue-derive.ts - Pure transform: inbox entries -> queue view-model.
 *
 * No IO, no fs, no side effects. All date arithmetic uses injected now.
 * Importable in any Vitest node-env test without mocking.
 *
 * Called from the home.tsx loader (server-side). No .server suffix because it
 * has no IO - the .server convention is reserved for filesystem-accessing modules.
 *
 * ASCII only - no em-dashes per FND-05 (check:dashes gate).
 */
import { addHours, formatDistance, isBefore } from "date-fns";
import type { MessageBlock } from "./blocks/model.js";
import type { ProjectCard } from "./projects.shared.js";

// --- Tier offsets -----------------------------------------------------------

const TIER_HOURS = {
  card: 24,
  plain: 48,
} as const;

/**
 * Build a valid Date from an untrusted string, falling back to `fallback`
 * when the value is missing or unparseable. Prevents a single malformed block
 * timestamp (e.g. an em-dash header that failed to parse and left an empty
 * timestamp) from throwing "Invalid time value" via toISOString/formatDistance
 * and 500-ing the entire queue loader. Ref: 2026-06-11 MC lifeline incident.
 */
function safeDate(value: string | undefined, fallback: Date): Date {
  if (value) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return fallback;
}

// --- Exported types ---------------------------------------------------------

/** A single item in the action-queue view-model. */
export interface QueueViewItem {
  /** Stable identity: agentName/timestamp/discriminator */
  id: string;
  agentName: string;
  /** Body collapsed to single line, trimmed, sliced to 80 chars. Falls back to "(no body)". */
  preview: string;
  /** ISO UTC deadline anchor. Card items: +24h; plain items: +48h from creation. */
  deadline: string;
  /** True when now is past the deadline. */
  overdue: boolean;
  /** Human-readable age string computed against the injected clock. */
  ageDisplay: string;
  /** Source block timestamp (used for tie-breaking sort). */
  createdAt: string;
  /** Always false in the returned list (handled items are excluded before output). */
  handled: boolean;
  /** True when the source block contains a decision card. */
  isCard: boolean;
  /** Present only when isCard is true. */
  decisionId?: string;
}

/** A single inbox block paired with its owning agent name. */
export interface InboxEntry {
  agentName: string;
  block: MessageBlock;
}

// --- Exported functions -----------------------------------------------------

/**
 * Derive a stable string identity for an inbox block.
 *
 * Format: agentName/timestamp/discriminator
 * Discriminator is the card's decisionId for card blocks, or the from field
 * for plain blocks. Encoding the timestamp as the middle segment means that
 * a new block from the same agent always gets a distinct id (QUEUE-09).
 */
export function deriveItemId(agentName: string, block: MessageBlock): string {
  const discriminator = block.card?.decisionId ?? block.header.from;
  return `${agentName}/${block.header.timestamp}/${discriminator}`;
}

/**
 * Derive the action-queue view-model from raw inbox entries.
 *
 * Pure function: no IO, no clock reads. All date arithmetic uses the injected
 * `now` parameter so tests can assert deterministic results.
 *
 * Filtering rules (items that are excluded from the output):
 * 1. Blocks from Alex (header.from === "alex")
 * 2. Blocks whose id appears in handledIds
 * 3. Answered card blocks (card.answered !== undefined) - reconciliation rule
 *
 * Deadline logic:
 * - If id appears in deadlineMap, the stored anchor is reused verbatim (no drift).
 * - Otherwise, deadline = addHours(new Date(timestamp), tierHours).toISOString()
 *   and the new anchor is added to the returned newDeadlines map.
 *
 * Sort order (QUEUE-03/04 deterministic tie-breaking):
 * 1. Overdue items before non-overdue
 * 2. Soonest deadline first
 * 3. Older createdAt first
 * 4. Lexicographic id
 *
 * @param entries   - All inbox blocks across agents (from the loader's readBlocks calls)
 * @param handledIds - Set of item ids already marked handled
 * @param deadlineMap - Map of id -> ISO deadline anchor (from FileQueueStore.getDeadlines)
 * @param now        - The current instant for overdue and ageDisplay calculation
 * @returns { items, newDeadlines } where newDeadlines contains only freshly-computed anchors
 */
export function deriveQueueItems(
  entries: InboxEntry[],
  handledIds: Set<string>,
  deadlineMap: Map<string, string>,
  now: Date,
  user: string = "alex"
): { items: QueueViewItem[]; newDeadlines: Map<string, string> } {
  const items: QueueViewItem[] = [];
  const newDeadlines = new Map<string, string>();

  for (const { agentName, block } of entries) {
    // Rule 1: Alex's own messages are not queued.
    if (block.header.from === user) continue; // own messages are not queued (TASK-462: per-instance user)

    const id = deriveItemId(agentName, block);
    const isCard = block.card !== undefined;
    const isAnswered = isCard && block.card!.answered !== undefined;

    // Rule 2 + 3: Skip handled and answered-card items.
    if (handledIds.has(id) || isAnswered) continue;

    // Resolve deadline: reuse stored anchor or compute fresh.
    let deadline: string;
    if (deadlineMap.has(id)) {
      deadline = deadlineMap.get(id)!;
      // Reused from map - do NOT add to newDeadlines.
    } else {
      const tierHours = isCard ? TIER_HOURS.card : TIER_HOURS.plain;
      deadline = addHours(safeDate(block.header.timestamp, now), tierHours).toISOString();
      newDeadlines.set(id, deadline);
    }

    const deadlineDate = safeDate(deadline, now);
    const overdue = isBefore(deadlineDate, now);

    // ageDisplay: injected two-arg formatDistance (wall-clock reads forbidden).
    // Always formatDistance(deadline, now) so that:
    //   future deadline -> "in X hours"  (QUEUE-05: "due in 4h" style)
    //   past deadline   -> "X hours ago" (QUEUE-05: "overdue 3h" style)
    // NOTE: the argument ORDER matters. formatDistance(a, b, {addSuffix}) produces
    // "in X" when a > b (a is in the future relative to b) and "X ago" when a < b.
    // Swapping to formatDistance(now, deadline) would yield "X ago" for FUTURE items.
    const ageDisplay = formatDistance(deadlineDate, now, { addSuffix: true });

    // Preview: collapse newlines, trim, slice to 80 chars, fallback "(no body)".
    const rawPreview = block.body.replace(/\n/g, " ").trim().slice(0, 80);
    const preview = rawPreview.length > 0 ? rawPreview : "(no body)";

    items.push({
      id,
      agentName,
      preview,
      deadline,
      overdue,
      ageDisplay,
      createdAt: block.header.timestamp,
      handled: false,
      isCard,
      ...(isCard ? { decisionId: block.card!.decisionId } : {}),
    });
  }

  // Deterministic sort: overdue-first, soonest deadline, older createdAt, lexicographic id.
  items.sort((a, b) => {
    // Step 1: overdue before non-overdue
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    // Step 2: soonest deadline first
    const deadlineDiff =
      new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    if (deadlineDiff !== 0) return deadlineDiff;
    // Step 3: older createdAt first
    const createdDiff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdDiff !== 0) return createdDiff;
    // Step 4: lexicographic id for full determinism
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { items, newDeadlines };
}

// ---------------------------------------------------------------------------
// CardsTabItem + deriveCardsTab (Thread C: the dedicated Decisions+Actions tab)
// ---------------------------------------------------------------------------

/** One live (unresolved) decision or action card on the dedicated tab. */
export interface CardsTabItem {
  agentName: string;
  block: MessageBlock;
  kind: "decision" | "action";
  /** Source block timestamp (the sort key). */
  createdAt: string;
}

/**
 * A decision card is resolved (terminal) when it is answered (incl. pushback,
 * which sets answered: "pushback"), dismissed, or superseded.
 */
export function isDecisionResolved(card: {
  answered?: string;
  dismissed?: string;
  superseded?: string;
}): boolean {
  return (
    card.answered !== undefined ||
    card.dismissed !== undefined ||
    card.superseded !== undefined
  );
}

/**
 * An action card is resolved (terminal) when it is done, dismissed, or superseded.
 */
export function isActionResolved(actionCard: {
  done?: string;
  dismissed?: string;
  superseded?: string;
}): boolean {
  return (
    actionCard.done !== undefined ||
    actionCard.dismissed !== undefined ||
    actionCard.superseded !== undefined
  );
}

/**
 * Derive the dedicated Decisions+Actions tab list from raw inbox entries.
 *
 * Pure function: no IO, no clock reads. This filter checks EVERY terminal state
 * - answered/dismissed/superseded for decisions, done/dismissed/superseded for
 * actions - so a card closed via the dismiss/supersede buttons leaves this tab
 * immediately. deriveNeedsYou now agrees on every one of those except a
 * DISMISSED DECISION, which the homepage/bell contract still surfaces (the
 * Option-1 freeze; see the comment at that check).
 * Blocked kanban cards are NOT included (this tab is decisions + actions only).
 *
 * Own messages (header.from === user) are excluded.
 * Sort: oldest createdAt first (stalest at the top), tie-broken by agentName
 * then card id, for full determinism.
 *
 * @param entries - All inbox blocks across agents.
 * @param user - The instance user whose own messages are excluded (TASK-462).
 */
export function deriveCardsTab(
  entries: InboxEntry[],
  user: string = "alex"
): CardsTabItem[] {
  const items: CardsTabItem[] = [];

  for (const { agentName, block } of entries) {
    if (block.header.from === user) continue;

    if (block.card !== undefined) {
      if (isDecisionResolved(block.card)) continue;
      items.push({
        agentName,
        block,
        kind: "decision",
        createdAt: block.header.timestamp,
      });
      continue;
    }

    if (block.actionCard !== undefined) {
      if (isActionResolved(block.actionCard)) continue;
      items.push({
        agentName,
        block,
        kind: "action",
        createdAt: block.header.timestamp,
      });
    }
  }

  items.sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    // A malformed/empty timestamp yields NaN; NaN arithmetic would treat the
    // pair as equal and skip the tie-breakers, making bad-data order random.
    // Sort valid timestamps ahead of invalid ones, then oldest (stalest) first.
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && aTime !== bTime) return aTime - bTime;
    if (a.agentName !== b.agentName) return a.agentName < b.agentName ? -1 : 1;
    const aId = a.block.card?.decisionId ?? a.block.actionCard?.actionId ?? "";
    const bId = b.block.card?.decisionId ?? b.block.actionCard?.actionId ?? "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  return items;
}

// ---------------------------------------------------------------------------
// NeedsYouItem + deriveNeedsYou
// ---------------------------------------------------------------------------

/**
 * A single item in the "Needs you" ranked list.
 * Covers three kinds: unanswered decisions, un-done action cards, blocked kanban cards.
 */
export interface NeedsYouItem {
  /** Stable identity for React keying and queue-store SLA tracking. */
  id: string;
  /** Which kind of item this is. */
  kind: "decision" | "action" | "blocked";
  agentName: string;
  /** Title/subject of the item. */
  title: string;
  /** ISO UTC deadline anchor (for SLA / overdue detection). */
  deadline: string;
  /** True when now is past the deadline. */
  overdue: boolean;
  /** Human-readable age/staleness string computed against injected clock. */
  ageDisplay: string;
  /** Source creation timestamp (used for tie-breaking). */
  createdAt: string;
  /** Deep link: decisions/actions -> /threads/<agent>#<id>; blocked -> /projects */
  deepLink: string;
  /** For decisions: stable decisionId (needed for inline answer). */
  decisionId?: string;
  /** For actions: stable actionId (needed for inline done tick). */
  actionId?: string;
  /** Optional priority string from the action card (e.g. "high"). */
  priority?: string;
  /** Optional ticket URL from the action card. */
  ticket?: string;
  /**
   * ADDITIVE (TASK-440): optional summary for blocked items (from card.summary).
   * Decisions and actions leave this unset.
   */
  summary?: string;
  /**
   * ADDITIVE (TASK-440): optional blocked-on annotation for blocked items (from card.blockedOn).
   * Decisions and actions leave this unset.
   */
  blockedOn?: string;
}

/**
 * Priority weight map: lower number = higher priority in sort. Vocabulary is
 * PINNED upstream (schema.normalisePriority: urgent | high | normal, unknown
 * warns + normalises to normal) so this map only ever sees pinned values.
 */
const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

function priorityWeight(p?: string): number {
  if (!p) return 2; // unset = normal
  return PRIORITY_WEIGHT[p.toLowerCase()] ?? 2;
}

/**
 * Derive the "Needs you" ranked list from inbox entries + blocked kanban cards.
 *
 * Pure function: no IO, no clock reads. All date arithmetic uses the injected
 * `now` parameter so tests can assert deterministic results.
 *
 * Three kinds of items:
 *   1. Open decision cards (block.card defined, not answered, not superseded)
 *   2. Open action cards (block.actionCard defined, not done, not dismissed,
 *      not superseded)
 *   3. Blocked kanban cards (blockedCards passed in, filtered to column "blocked")
 *
 * A DISMISSED DECISION is the one terminal state this function does not honour;
 * see the comment at that check for why it is a deliberate divergence rather
 * than an oversight.
 *
 * Items from Alex (header.from === "alex") are excluded.
 * Items whose id is in handledIds are excluded.
 *
 * Deadline logic:
 * - Decision/action items: reuse stored anchor from deadlineMap when present;
 *   otherwise compute and add to newDeadlines.
 * - Blocked cards: deadline = card.updated + 48h (plain tier); not SLA-persisted.
 *
 * Sort (one comparator, PLAN spec):
 *   1. Overdue desc (overdue items first)
 *   2. Priority asc (high < medium < low/unset)
 *   3. Age desc (older createdAt first)
 *   4. Lexicographic id for full determinism
 *
 * @param entries       All inbox blocks across agents
 * @param blockedCards  All project cards (caller passes listCards() output; this
 *                      function filters to column "blocked" internally, keeping it pure)
 * @param handledIds    Set of ids already marked handled in the queue store
 * @param deadlineMap   Map of id -> ISO deadline anchor from FileQueueStore
 * @param now           Current instant for overdue and ageDisplay calculation
 * @returns { items, newDeadlines }
 */
export function deriveNeedsYou(
  entries: InboxEntry[],
  blockedCards: ProjectCard[],
  handledIds: Set<string>,
  deadlineMap: Map<string, string>,
  now: Date,
  user: string = "alex"
): { items: NeedsYouItem[]; newDeadlines: Map<string, string> } {
  const items: NeedsYouItem[] = [];
  const newDeadlines = new Map<string, string>();

  // --- 1. Inbox entries: decisions + actions ---
  for (const { agentName, block } of entries) {
    if (block.header.from === user) continue; // own messages are not queued (TASK-462: per-instance user)

    // --- Decision card ---
    if (block.card !== undefined) {
      if (block.card.answered !== undefined) continue; // already answered
      // SUPERSEDED IS TERMINAL HERE TOO, as of the activity-sweep port. It was
      // not, and that was one repository holding three answers to one question:
      // isDecisionResolved, the card components and the Cards tab all treated a
      // superseded card as resolved, while this function did not, and neither
      // did the ported sweep's classifier. Harmless while the divergence was
      // invisible; not harmless once a second reader publishes a needs-you
      // status from the same files, because a card the reader has already
      // closed goes on driving that status for the rest of the card window.
      //
      // STILL DIVERGENT, deliberately and separately: a DISMISSED decision.
      // deriveCardsTab and the card components treat it as resolved; this
      // function does not, which is the Option-1 freeze of the homepage/bell
      // contract made when dismiss landed, pinned by its own guard test, and a
      // product decision about the homepage rather than a transcription error.
      // Recorded in docs/protocol.md section 11 (known deviations) rather
      // than changed in passing. A dismissed ACTION was already excluded below, so the
      // divergence is one state on one card kind.
      if (block.card.superseded !== undefined) continue; // superseded in place

      const id = `${agentName}/${block.header.timestamp}/${block.card.decisionId}`;
      if (handledIds.has(id)) continue;

      let deadline: string;
      if (deadlineMap.has(id)) {
        deadline = deadlineMap.get(id)!;
      } else {
        deadline = addHours(safeDate(block.header.timestamp, now), TIER_HOURS.card).toISOString();
        newDeadlines.set(id, deadline);
      }

      const deadlineDate = safeDate(deadline, now);
      const overdue = isBefore(deadlineDate, now);
      const ageDisplay = formatDistance(deadlineDate, now, { addSuffix: true });

      items.push({
        id,
        kind: "decision",
        agentName,
        title: block.header.subject || "(no subject)",
        deadline,
        overdue,
        ageDisplay,
        createdAt: block.header.timestamp,
        deepLink: `/threads/${agentName}#${block.card.decisionId}`,
        decisionId: block.card.decisionId,
      });
      continue;
    }

    // --- Action card ---
    if (block.actionCard !== undefined) {
      if (block.actionCard.done !== undefined) continue; // already done
      if (block.actionCard.dismissed !== undefined) continue; // dismissed
      // Superseded: see the decision branch above. An action's three terminal
      // states are now all checked here, so isActionResolved and this function
      // agree completely.
      if (block.actionCard.superseded !== undefined) continue; // superseded in place

      const id = `${agentName}/${block.header.timestamp}/${block.actionCard.actionId}`;
      if (handledIds.has(id)) continue;

      let deadline: string;
      if (deadlineMap.has(id)) {
        deadline = deadlineMap.get(id)!;
      } else {
        deadline = addHours(safeDate(block.header.timestamp, now), TIER_HOURS.card).toISOString();
        newDeadlines.set(id, deadline);
      }

      const deadlineDate = safeDate(deadline, now);
      const overdue = isBefore(deadlineDate, now);
      const ageDisplay = formatDistance(deadlineDate, now, { addSuffix: true });

      items.push({
        id,
        kind: "action",
        agentName,
        title: block.header.subject || "(no subject)",
        deadline,
        overdue,
        ageDisplay,
        createdAt: block.header.timestamp,
        deepLink: `/threads/${agentName}#${block.actionCard.actionId}`,
        actionId: block.actionCard.actionId,
        priority: block.actionCard.priority,
        ticket: block.actionCard.ticket,
      });
    }
  }

  // --- 2. Blocked kanban cards ---
  for (const card of blockedCards) {
    if (card.column !== "blocked") continue;

    const id = `blocked/${card.id}`;
    if (handledIds.has(id)) continue;

    // Blocked cards: deadline = updated + 48h (plain tier). Not SLA-persisted.
    const deadline = addHours(safeDate(card.updated, now), TIER_HOURS.plain).toISOString();
    const deadlineDate = safeDate(deadline, now);
    const overdue = isBefore(deadlineDate, now);
    const ageDisplay = formatDistance(deadlineDate, now, { addSuffix: true });

    items.push({
      id,
      kind: "blocked",
      agentName: card.agent,
      title: card.title,
      deadline,
      overdue,
      ageDisplay,
      createdAt: card.updated,
      deepLink: "/projects",
      ticket: card.ticket,
      ...(card.summary ? { summary: card.summary } : {}),
      ...(card.blockedOn ? { blockedOn: card.blockedOn } : {}),
    });
  }

  // Sort: overdue desc, priority asc, age desc (older first), lexicographic id.
  items.sort((a, b) => {
    // Step 1: overdue before non-overdue
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    // Step 2: priority (lower weight = higher priority = first)
    const pDiff = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (pDiff !== 0) return pDiff;
    // Step 3: older createdAt first
    const createdDiff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdDiff !== 0) return createdDiff;
    // Step 4: lexicographic id for full determinism
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { items, newDeadlines };
}
