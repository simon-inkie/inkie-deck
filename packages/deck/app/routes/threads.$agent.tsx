/**
 * threads.$agent.tsx - Thread view route for a single agent inbox.
 *
 * Loader reads all message blocks from the agent's inbox through the seam
 * (makeStores -> inbox.readBlocks). The component renders them chronologically
 * with own-vs-agent distinction, interactive DecisionCard components for
 * card blocks, and a Compose box at the bottom.
 *
 * Action dispatches compose/answer/pushback/custom intents to the seam:
 * - compose: inbox.writeReply (THRD-04), or inbox.customAnswerCard when the
 *   thread has an open decision card (TASK-475: free text resolves it)
 * - answer: inbox.answerCard (CARD-02, CARD-04)
 * - pushback: inbox.pushBackCard (CARD-03, CARD-04)
 * - custom: inbox.customAnswerCard (MC-02, user-authored answer)
 *
 * SEAM RULE (FND-02, T-01-12): this file imports ONLY makeStores from
 * ~/lib/stores.server. It does NOT import node:fs, fs, or any direct
 * filesystem path. The static seam.test.ts enforces this at test time.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { useFetcher, useFetchers, useLocation, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/threads.$agent";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { makeStores } from "~/lib/stores.server";
import { resolveNow } from "~/lib/time";
import { mcUser, tmuxEnabled } from "~/lib/instance.server";
import { saveAttachment } from "~/lib/attachments.server";
import { getVoiceProxyUrl, getVoiceDisabledReason } from "~/lib/voice.server";
import { linkifyBlockBodies } from "~/lib/review.server";
import { listCards } from "~/lib/projects.server";
import type { MessageBlock } from "~/lib/blocks/model";
import { isSuperseded } from "~/lib/blocks/working";
// TASK-475: the shared "is this decision card still open" predicate. queue-derive
// is a pure module (no fs, no .server suffix), so importing it here does not
// breach the seam rule above.
import { isDecisionResolved } from "~/lib/queue-derive";
// Shared with the Cards tab: the shape of the cross-route "reply to this card"
// deep link, and the rule for when it may seed card-reply mode. Also a pure
// module - no fs, no .server suffix.
import { REPLY_PARAM, canSeedCardReply } from "~/lib/card-reply-link";
import { MessageBubble } from "~/components/MessageBubble";
import { DayDivider } from "~/components/DayDivider";
import { DecisionCard } from "~/components/DecisionCard";
import { ActionCard } from "~/components/ActionCard";
import { Compose } from "~/components/Compose";
import { PendingBubble } from "~/components/PendingBubble";
import { PendingStatusLine } from "~/components/PendingStatusLine";
import { EmptyState } from "~/components/EmptyState";
import {
  usePendingBatch,
  buildBatchBody,
  type BatchDelivery,
} from "~/lib/pending-batch";
import {
  clearBatch,
  flushViaBeacon,
  mirrorPendingBatch,
  takeRecoveredBatch,
} from "~/lib/batch-durability";
import { useBatchPrefs } from "~/lib/batch-prefs";
import { usePersistedPanelState } from "~/lib/panel-state";
import { ReviewPanel, DOC_PARAM } from "~/components/ReviewPanel";
import { FilesPanel } from "~/components/FilesPanel";
import { isNearBottom, shouldFollow } from "~/lib/scroll-follow";
import { avatarUrl } from "~/lib/avatars.server";
import { captureTmuxPane, wakeIdleAgent, pushMessageToIdleAgent } from "~/lib/tmux.server";
import { TmuxPane } from "~/components/TmuxPane";
import { MessageSquare } from "lucide-react";
import { formatDayDivider, londonDayKey } from "~/lib/time";

/**
 * TASK-465: cheap djb2 fingerprint of the captured agent pane. Only the hash is
 * sent to the client - the pane text never crosses into the chat payload.
 * Returns null when there is no pane (tmux unavailable / window gone), which the
 * client reads as "no activity signal".
 */
function hashPane(pane: string | undefined): string | null {
  if (pane === undefined) return null;
  let h = 5381;
  for (let i = 0; i < pane.length; i++) {
    h = ((h << 5) + h + pane.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

// ---------------------------------------------------------------------------
// Intent schema (named export consumed by test/action-intent.test.ts)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the thread action's discriminated intent field.
 * Validates all four intents at the action boundary (T-02-09).
 * Exported as a named symbol so unit tests import the schema without
 * importing the full route module (which has server-side side-effects).
 */
export const intentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("compose"),
    body: z.string().trim().min(1, "Reply body must not be empty"),
    // Dictation provenance (2026-06-11): "1" when any of the body came from
    // voice transcription. Optional - absent on typed messages.
    dictated: z.string().optional(),
    // Explicit write target for the deliver-on-switch path (TASK-500 #2a): when
    // the user switches threads with a pending batch, the hook delivers to the OLD
    // agent by setting this field. Validated against the roster naming convention;
    // the underlying writeReply + assertSafeWritePath provides the confinement
    // backstop. Falls back to params.agent when absent (normal same-thread flow).
    // Regex mirrors AGENT_NAME_RE in safe-fs.server, kept inline so this
    // client-bundled schema does not import a .server module (which breaks the
    // production build). assertSafeWritePath is the real server-side guard.
    targetAgent: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  }),
  z.object({
    intent: z.literal("answer"),
    decisionId: z.string().trim().min(1, "decisionId is required"),
    answerKey: z.string().trim().min(1, "answerKey is required"),
  }),
  z.object({
    intent: z.literal("pushback"),
    decisionId: z.string().trim().min(1, "decisionId is required"),
    note: z.string().optional(),
  }),
  z.object({
    intent: z.literal("custom"),
    decisionId: z.string().trim().min(1, "decisionId is required"),
    text: z.string().trim().min(1, "Custom answer text must not be empty"),
  }),
  z.object({
    intent: z.literal("done"),
    actionId: z.string().trim().min(1, "actionId is required"),
  }),
  z.object({
    intent: z.literal("dismiss"),
    actionId: z.string().trim().min(1, "actionId is required"),
    reason: z.string().optional(),
  }),
  z.object({
    intent: z.literal("doneNote"),
    actionId: z.string().trim().min(1, "actionId is required"),
    note: z.string().trim().min(1, "note is required"),
  }),
  // Thread C: decision-card dismiss + supersede (both card types).
  z.object({
    intent: z.literal("dismissDecision"),
    decisionId: z.string().trim().min(1, "decisionId is required"),
    reason: z.string().optional(),
  }),
  z.object({
    intent: z.literal("supersedeDecision"),
    decisionId: z.string().trim().min(1, "decisionId is required"),
    note: z.string().optional(),
  }),
  z.object({
    intent: z.literal("supersedeAction"),
    actionId: z.string().trim().min(1, "actionId is required"),
    note: z.string().optional(),
  }),
]);

export type IntentPayload = z.infer<typeof intentSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
// TASK-454: mini-card derivation moved to projects.shared.ts (toMiniCards) -
// the work panel is fed by the SHELL loader now. This loader keeps listCards
// only for the ticketColumns synergy-badge map (TASK-445).

export async function loader({ params, request }: Route.LoaderArgs) {
  const { inbox } = makeStores(process.env);
  const agent = params.agent;

  // TASK-437 amendment: ?view=tmux flips the thread to the agent's live
  // pane. Unknown values fall back to chat.
  // TASK-462: per-instance user + tmux gating (a disabled instance ignores
  // ?view=tmux entirely - server-side, not just hidden UI).
  const user = mcUser(process.env);
  const tmuxOn = tmuxEnabled(process.env);
  const requestUrl = new URL(request.url);
  const tmuxView = tmuxOn && requestUrl.searchParams.get("view") === "tmux";

  // TASK-443 follow-on: Alex rendering the thread IS the read - flip the
  // agent's sent blocks to read on disk BEFORE reading, so the receipt is
  // durable and this render already shows the flipped state. A receipt
  // failure (e.g. allowlist refusal on a direct URL) must never break the
  // render - log and serve the thread read-only.
  // TASK-437 amendment: SKIPPED in tmux view - terminal mode renders no
  // messages, and the 1s poll would otherwise mark unseen messages read.
  // Render-is-the-receipt only counts when the messages actually render.
  if (!tmuxView) {
    try {
      await inbox.markRead(agent, user);
    } catch (err) {
      console.error(
        `[threads] read-receipt flip failed for ${agent}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  // TASK-469: windowed read - the loader returns the last ~30 blocks (or, on a
  // deep-link ?anchor=<card-id>, the window extended back to that card). The
  // client lazy-loads older chunks via api/thread-window on scroll-up. The
  // markRead flip above is deliberately UNTOUCHED: it operates whole-file, so
  // out-of-window sent blocks still flip on thread open (render-is-the-receipt).
  const anchorParam = requestUrl.searchParams.get("anchor");
  const {
    blocks: rawBlocks,
    startIndex,
    totalCount,
  } = await inbox.readBlocksWindow(agent, user, {
    anchorId: anchorParam ?? undefined,
  });
  // TASK-645: rewrite bare / backticked review-root doc paths in each block body
  // into real clickable markdown links, at render time (retroactive - fixes
  // already-sent messages too). Reuses the review-panel containment validation;
  // paths outside a review root are left as plain text. Never throws.
  const blocks = linkifyBlockBodies(rawBlocks);
  // Return now as an ISO string so timestamps use a single server-side instant.
  // Pitfall 5: pass strings, not Date objects, across the serialization boundary.
  const now = resolveNow(process.env["MC_NOW"]);
  const nowIso = now.toISOString();
  // Voice config: proxyUrl arrives via loader data so components never read env (FND-02).
  const voice = {
    proxyUrl: getVoiceProxyUrl(process.env),
    disabledReason: getVoiceDisabledReason(process.env),
  };

  // TASK-445: build a ticketId -> {column, cardId} map for the synergy badge.
  // Guarded listCards() (try/catch -> {} exactly like home.tsx).
  const ticketColumns: Record<string, { column: string; cardId: string }> = {};
  try {
    const allCards = listCards();
    // Build ticketId -> card map for all cards with a normalised ticket id.
    // On duplicate ticket ids (edge case), newest-updated card wins (list is sorted updated-desc).
    for (const c of allCards) {
      if (c.ticketId !== undefined && !(c.ticketId in ticketColumns)) {
        ticketColumns[c.ticketId] = { column: c.column, cardId: c.id };
      }
    }
  } catch {
    // Projects root not set or unreadable - badge map absent.
  }

  // TASK-457: avatar URLs for every distinct sending agent in this thread
  // (cross-posts exist - blocks are not all from the thread agent).
  const avatarUrls: Record<string, string> = {};
  for (const b of blocks) {
    const from = b.header.from;
    if (from === user || from in avatarUrls) continue;
    const url = avatarUrl(from);
    if (url !== undefined) avatarUrls[from] = url;
  }

  // TASK-437 amendment: capture the agent's live pane only in tmux view.
  const tmux = tmuxView
    ? { pane: captureTmuxPane(process.env, agent) }
    : undefined;

  // TASK-465 (working indicator, option A): when Alex's last message is
  // unanswered, fingerprint the agent's live tmux pane so the client can show a
  // "working" indicator while the pane keeps stirring. Guarded to the pending
  // case so we never spawn a tmux subprocess per poll on an already-answered
  // thread (or in tmux view, which captures the pane itself). Only the HASH
  // leaves the server here - no pane text crosses into the chat payload.
  const latestBlock = blocks[blocks.length - 1];
  const awaitingAgent = !tmuxView && latestBlock?.header.from === user;
  const agentPaneHash = awaitingAgent
    ? hashPane(captureTmuxPane(process.env, agent))
    : null;

  return {
    agent,
    blocks,
    // TASK-469: absolute index of blocks[0] in the full thread + total block
    // count - the client's pagination cursor and ordering base.
    startIndex,
    totalCount,
    now: nowIso,
    voice,
    ticketColumns,
    avatarUrls,
    tmux,
    agentPaneHash,
    user,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Intent-dispatch action for the thread view.
 *
 * Reads formData, validates against intentSchema (T-02-09), then routes to
 * the appropriate seam method. Unknown intents and malformed payloads return
 * { ok: false, error } rather than throwing (fail-safe).
 *
 * Imports ONLY makeStores + zod + model types. No fs, no banned path strings.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const agent = params.agent;

  // Handle intent=attach BEFORE the zod discriminated union.
  // File objects do not zod-parse cleanly; validate manually here.
  const attachIntent = formData.get("intent");
  if (attachIntent === "attach") {
    const files = formData.getAll("files[]") as File[];

    if (!files || files.length === 0) {
      return { ok: false, error: "No files provided." };
    }
    if (files.length > 5) {
      return { ok: false, error: "Maximum 5 files per upload." };
    }

    const results: Array<{ markdown: string }> = [];
    for (const file of files) {
      // Read file bytes into a Buffer.
      const arrayBuffer = await file.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      try {
        const result = await saveAttachment(agent, {
          name: file.name,
          type: file.type,
          bytes,
        });
        results.push({ markdown: result.markdown });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    }

    return { ok: true, attachments: results };
  }

  const raw = Object.fromEntries(formData);

  // Validate at the boundary (T-02-09: parse-don't-validate)
  const parsed = intentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten() };
  }

  const { inbox } = makeStores(process.env);
  // TASK-462: per-instance user - replies and card answers carry this identity.
  const user = mcUser(process.env);

  const payload = parsed.data;

  // #91: when an idle agent receives a human message, poke its tmux pane so it
  // picks the message up now (hook-inject only delivers on the agent's next
  // turn; an idle agent takes no turn on its own). Fire-and-forget - NOT
  // awaited - because the send-keys path sleeps ~1s before Enter and the
  // operator's send must stay instant. Gated to tmux-enabled instances
  // (Robin's is off). wakeIdleAgent is a no-op on an active pane.
  const wakeTarget = (target: string) => {
    if (tmuxEnabled(process.env)) {
      void wakeIdleAgent(process.env, target, user).catch(() => {});
    }
  };

  // TASK-524: text-carry push for the compose (chat-box) path. Supersedes the
  // generic #91 wake nudge on this path - the message text IS the wake, so we
  // push it directly rather than also firing a "check your inbox" nudge (avoids
  // a double-fire). Card paths (answer/custom/pushback) carry no free text, so
  // they keep the generic wakeTarget call unchanged.
  // `dictated` rides along rather than being inferred at the seam: the flag is a
  // property of how the message was COMPOSED, and only this action knows it. It is
  // written into the stored block a few lines below (rawMeta) and was, until
  // 2026-08-11, dropped here, so the pane got transcription with no sign it was
  // transcription. Both call sites pass it; the compose path is the reported case
  // and the custom-answer-card path drops it identically if you only fix the one.
  // `dictated` is REQUIRED here, deliberately, while the two exported functions it
  // calls keep their defaults (peer review of !42). Those have one caller each
  // and stable signatures; this closure is the seam the bug actually lived at. A
  // default here means a third push path added in six months silently reintroduces
  // the drop with no error, no failing test and no reviewer prompt. Given the family
  // of MC defects around this one is fields going missing at seams where nobody was
  // asked, the compiler should be the one asking.
  const pushTarget = (target: string, body: string, dictated: boolean) => {
    if (tmuxEnabled(process.env)) {
      void pushMessageToIdleAgent(process.env, target, user, body, dictated).catch(
        () => {}
      );
    }
  };

  if (payload.intent === "compose") {
    // Derived ONCE for this branch (peer review of !42). It was computed
    // separately at each of the three sites below; if those ever diverged, the
    // stored block and the pane would disagree about what the message is, which
    // is precisely the defect this change exists to fix.
    const isDictated = payload.dictated === "1";
    // THRD-04: build a reply MessageBlock and write it through the seam
    // TASK-500 #2a: deliver-on-switch path sets targetAgent to the OLD thread's
    // agent. Normal same-thread delivery omits it (falls back to params.agent).
    // writeTarget is the single correct identifier for "which thread this reply
    // is actually going into" - derive it FIRST so the subject read below keys
    // off the same thread the reply is written to. Reading from the route param
    // `agent` while writing to `writeTarget` bled a different thread's subject
    // onto the reply on the deliver-on-switch path (route on A, write to B).
    const writeTarget = payload.targetAgent ?? agent;
    // Derive the subject from the last agent block in the target thread
    // readonly: readBlocks serves a frozen, module-cached array. The spread
    // below already copies before .reverse() - that copy is now load-bearing.
    const blocks: readonly MessageBlock[] = await inbox.readBlocks(
      writeTarget,
      user,
    );
    const lastAgentBlock = [...blocks]
      .reverse()
      .find((b) => b.header.from !== user);
    const lastAgentSubject = lastAgentBlock?.header.subject;

    // TASK-475: a free-text reply into a thread that still has an open decision
    // card resolves that card as its custom (option C) answer, instead of
    // landing as a plain message and leaving the card awaiting a tap forever.
    // Stale-open cards bury the live ask (an old poke-nova card sat open behind
    // a fresh one). Same array as the subject read above - no second read.
    //
    // v1 scope (decided on the ticket, not re-derived here):
    // - MOST-RECENT still-open decision card only, never an earlier one and
    //   never more than one. Blocks are append-only, so scan from the end.
    // - `block.card` is decision-only (action cards parse into `actionCard`),
    //   so action cards are excluded by construction.
    // - Tangential free text auto-resolves the card too. Accepted: a wrong
    //   auto-resolve is re-cardable, a stale-open card is not visible at all.
    // EMERGENCY DISABLE (2026-07-29, Alex): the "most-recent open card" scan
    // has no age bound, so it walked back WEEKS of history and silently
    // auto-resolved long-abandoned cards with unrelated free text (confirmed:
    // a June 11 decision card on Summit's thread got overwritten by a July 29
    // message about an unrelated topic). Disabled pending a proper age-bounded
    // fix - falls through to the plain writeReply path below unconditionally.
    const INK_475_DISABLED = true;
    const openCard = INK_475_DISABLED
      ? undefined
      : [...blocks]
          .reverse()
          .find((b) => b.card !== undefined && !isDecisionResolved(b.card));

    if (openCard?.card) {
      // customAnswerCard does the whole writeback itself (locks the file, flips
      // the original to "answered: custom" + "custom-answer:", AND appends the reply
      // block carrying the free text) - so no writeReply on this path, or the
      // text would land twice. Same seam the "Or say something else" affordance
      // uses via intent === "custom" below.
      const result = await inbox.customAnswerCard(
        writeTarget,
        user,
        openCard.card.decisionId,
        payload.body,
      );
      const alreadyAnswered = "alreadyAnswered" in result;
      // TASK-524 applies identically here: the text IS the wake, whichever seam
      // wrote it. Mirrors the intent === "custom" return shape so the client
      // needs no new branching.
      // Dictation rides this path too, BUT NOTE THIS BRANCH IS CURRENTLY DEAD:
      // INK_475_DISABLED above is hard-true (Alex's emergency disable,
      // 2026-07-29), so openCard is always undefined and this never runs. The
      // flag is threaded anyway so re-enabling TASK-475 does not silently
      // reintroduce the drop, but it buys nothing today and must not be counted
      // as covering the live custom-answer path.
      //
      // The LIVE voice-answers-a-card case is `intent === "custom"` further
      // down, which calls wakeTarget (a generic nudge, no text) and stores only
      // `answer: custom`, so it loses dictation provenance in the RECORD as well as
      // the push. Deliberately out of scope here: fixing it means threading the
      // flag through the schema and applyCustomAnswer's locked write path, and
      // swapping a nudge for a text push is a behaviour change that does not
      // belong in a provenance fix. Tracked separately.
      pushTarget(writeTarget, payload.body, isDictated);
      return { ok: true, alreadyAnswered };
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const replyBlock: MessageBlock = {
      header: {
        timestamp,
        from: user,
        status: "sent",
        subject: lastAgentSubject ? `Re: ${lastAgentSubject}` : "Message",
      },
      body: payload.body,
      // Dictation provenance marker: a meta line in the written block, so
      // both the MC bubble and agents reading the raw markdown know the text
      // is transcribed speech (may carry transcription wonk).
      rawMeta: isDictated ? "dictated: true" : "",
      card: undefined,
    };

    await inbox.writeReply(writeTarget, user, replyBlock);
    // TASK-524: push the actual message text to the pane (supersedes #91 generic
    // wake on this path - the text IS the wake, no double-fire needed).
    // Same dictated flag that went into rawMeta above, so the pane and the stored
    // block now agree about what this message is.
    pushTarget(writeTarget, payload.body, isDictated);
    return { ok: true };
  }

  if (payload.intent === "answer") {
    // CARD-02, CARD-04: answer the card by stable decision-id
    const result = await inbox.answerCard(
      agent,
      user,
      payload.decisionId,
      payload.answerKey
    );
    const alreadyAnswered = "alreadyAnswered" in result;
    wakeTarget(agent);
    return { ok: true, alreadyAnswered };
  }

  if (payload.intent === "custom") {
    // MC-02: apply user-authored option C answer by stable decision-id
    const result = await inbox.customAnswerCard(
      agent,
      user,
      payload.decisionId,
      payload.text
    );
    const alreadyAnswered = "alreadyAnswered" in result;
    wakeTarget(agent);
    return { ok: true, alreadyAnswered };
  }

  if (payload.intent === "done") {
    // Mark an action card as done by stable action-id
    const result = await inbox.markActionDone(agent, user, payload.actionId);
    const alreadyDone = "alreadyDone" in result;
    return { ok: true, alreadyDone };
  }

  if (payload.intent === "dismiss") {
    // Dismiss an action card with an optional reason
    const result = await inbox.markActionDismissed(agent, user, payload.actionId, payload.reason);
    const alreadyDismissed = "alreadyDismissed" in result;
    const alreadyDone = "alreadyDone" in result;
    return { ok: true, alreadyDismissed, alreadyDone };
  }

  if (payload.intent === "doneNote") {
    // Add a note to an already-done action card
    const result = await inbox.addActionNote(agent, user, payload.actionId, payload.note);
    const alreadyNoted = "alreadyNoted" in result;
    const notDone = "notDone" in result;
    return { ok: true, alreadyNoted, notDone };
  }

  if (payload.intent === "dismissDecision") {
    // Thread C: dismiss a decision card with an optional reason. Mirrors the
    // action-dismiss handler shape (no wake nudge - a closing action).
    const result = await inbox.dismissDecisionCard(agent, user, payload.decisionId, payload.reason);
    const alreadyDismissed = "alreadyDismissed" in result;
    const alreadyAnswered = "alreadyAnswered" in result;
    const alreadySuperseded = "alreadySuperseded" in result;
    return { ok: true, alreadyDismissed, alreadyAnswered, alreadySuperseded };
  }

  if (payload.intent === "supersedeDecision") {
    // Thread C: supersede a decision card with an optional note.
    const result = await inbox.supersedeDecisionCard(agent, user, payload.decisionId, payload.note);
    const alreadySuperseded = "alreadySuperseded" in result;
    const alreadyAnswered = "alreadyAnswered" in result;
    const alreadyDismissed = "alreadyDismissed" in result;
    return { ok: true, alreadySuperseded, alreadyAnswered, alreadyDismissed };
  }

  if (payload.intent === "supersedeAction") {
    // Thread C: supersede an action card with an optional note.
    const result = await inbox.supersedeActionCard(agent, user, payload.actionId, payload.note);
    const alreadySuperseded = "alreadySuperseded" in result;
    const alreadyDone = "alreadyDone" in result;
    const alreadyDismissed = "alreadyDismissed" in result;
    return { ok: true, alreadySuperseded, alreadyDone, alreadyDismissed };
  }

  // payload.intent === "pushback"
  // CARD-03, CARD-04: push back by stable decision-id
  const result = await inbox.pushBackCard(
    agent,
    user,
    payload.decisionId,
    payload.note
  );
  const alreadyResolved = "alreadyResolved" in result;
  wakeTarget(agent);
  return { ok: true, alreadyResolved };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TASK-469: chunked lazy-load plumbing (client-side)
// ---------------------------------------------------------------------------

/** Window block typed as the loader serialises it (plain JSON shape). */
type WindowBlock = Route.ComponentProps["loaderData"]["blocks"][number];

/** JSON shape returned by api/thread-window (load-older chunks). */
interface ThreadWindowChunk {
  ok: boolean;
  agent: string;
  blocks: WindowBlock[];
  startIndex: number;
  totalCount: number;
  avatarUrls: Record<string, string>;
}

/**
 * Blocks retained client-side, keyed by ABSOLUTE thread index. Inbox files
 * are append-only at block granularity, so the absolute index is a stable
 * identity (the pagination cursor and the ordering key). Holds (a) older
 * chunks fetched on scroll-up and (b) blocks that slid out of the live
 * loader window as new messages appended - once loaded, a block never
 * unmounts under the user.
 */
interface RetainedBlocks {
  agent: string;
  map: Map<number, WindowBlock>;
}

/**
 * Form intents that ALWAYS mutate an EXISTING block in place (card answers,
 * action done/dismiss). Completion of one of these must refresh the retained
 * below-window copies, or the stale unanswered card keeps rendering
 * (2026-06-11 "clicking doesn't work" fix). Plain reply/compose appends a
 * NEW tail block instead - the live window covers those.
 *
 * "compose" is deliberately NOT in this set even though TASK-475 gave it a
 * card-flipping path: see refreshesRetainedBlocks below.
 */
const CARD_ACTION_INTENTS = new Set([
  "answer",
  "custom",
  "pushback",
  "done",
  "dismiss",
  "doneNote",
  "dismissDecision",
  "supersedeDecision",
  "supersedeAction",
]);

/**
 * Minimal shape this module needs off a fetcher. Structurally satisfied by
 * react-router's Fetcher (what useFetchers returns), and cheap to build in a
 * unit test without a router.
 */
export interface RefreshGateFetcher {
  state: string;
  formData?: FormData | undefined;
  data?: unknown;
}

/**
 * Does this in-flight fetcher mutate a block that may be sitting BELOW the
 * live window, so its completion has to re-fetch the retained range?
 *
 * True for every CARD_ACTION_INTENTS intent, plus the one compose case that
 * also flips a card in place: TASK-475's free-text auto-resolve (a reply typed
 * into a thread with an open decision card resolves it as the custom answer).
 *
 * The compose test is deliberately NOT `intent === "compose"`. Compose is
 * overwhelmingly a PLAIN reply, which appends a tail block the live window
 * already renders; matching on the intent alone would fire a below-window
 * refetch on every single message sent, for nothing. The action's return
 * value is the discriminator instead: the auto-resolve branch returns
 * { ok, alreadyAnswered } and the plain-reply branch returns a bare { ok },
 * so the PRESENCE of the `alreadyAnswered` key means customAnswerCard ran.
 * Either boolean value counts - `false` is "resolved it now", `true` is the
 * idempotent no-op on an already-answered card, and both mean the on-disk
 * block differs from the retained copy.
 *
 * Readable here because react-router populates fetcher.data during the
 * post-action `loading` (revalidation) phase while formData is still set, so
 * the key lands inside the same non-idle window this predicate watches, one
 * render before the fetcher goes idle and the caller's rising-edge fires. A
 * fetcher that is merely being REVALIDATED carries stale data but NO
 * formData, so it can never match.
 *
 * Exported for test/retained-refresh.test.ts.
 */
export function refreshesRetainedBlocks(fetcher: RefreshGateFetcher): boolean {
  if (fetcher.state === "idle") return false;
  const intent = fetcher.formData?.get("intent");
  if (typeof intent !== "string") return false;
  if (CARD_ACTION_INTENTS.has(intent)) return true;
  if (intent !== "compose") return false;
  return (
    typeof fetcher.data === "object" &&
    fetcher.data !== null &&
    "alreadyAnswered" in fetcher.data
  );
}

export default function ThreadView({ loaderData }: Route.ComponentProps) {
  const {
    agent,
    blocks,
    startIndex,
    totalCount,
    now,
    voice,
    ticketColumns,
    avatarUrls,
    tmux,
    agentPaneHash,
    user,
  } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const docParam = searchParams.get(DOC_PARAM);

  // ?debug=1 enables the voice debug panel (pure client-side UI state, not a loader value).
  // Read via useSearchParams so it is never in the server loader (FND-02).
  const debugParam = searchParams.get("debug");
  const debugEnabled = debugParam === "1";

  // Route-level state for the "write your own option C" flow.
  // respondingToDecisionId: which card the user is currently composing for.
  // customDraft: the live text the user is typing (mirrors into the C-row preview).
  const [respondingToDecisionId, setRespondingToDecisionId] = useState<string | undefined>(
    undefined
  );
  const [customDraft, setCustomDraft] = useState("");
  const composeRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // TASK-500: typing-aware message batching. The batch fetcher fires the real
  // intent=compose POST once the pending batch settles (or on send-now). The
  // pending batch state lives HERE (not in Compose) so the PendingBubble can
  // render in the message list above the composer.
  // ---------------------------------------------------------------------------

  const batchFetcher = useFetcher();
  // A separate fetcher for recovery submits (2026-07-28). This route already
  // learned once, the hard way, that consecutive submits on ONE fetcher
  // abort each other in React Router 7.16. That fix scoped recovery to exactly
  // one submit per mount, but batchFetcher is also used for onDeliver (normal
  // settle AND deliver-on-switch), and both effects key off the same `agent`
  // change - so a thread switch that both delivers the OLD thread's pending
  // batch and recovers an abandoned batch on the NEW thread could still fire
  // two submits on the shared fetcher in the same render pass, and the second
  // would abort the first. Separate fetcher instances can never contend.
  const recoveryFetcher = useFetcher();

  // TASK-500.1: per-browser batch display preferences (indicator mode + hold time).
  // Single source of truth: useBatchPrefs called once here, passed down to Compose.
  const [batchPrefs, setBatchPrefs] = useBatchPrefs();

  // Dictation provenance lives on the batch (PendingBatchState.dictated), not in
  // a route-level ref. The ref version was only ever reset inside onDeliver, so
  // a cancelled dictation left it armed and falsely stamped the next plain typed
  // message - on any thread - as dictated.

  // Declared ABOVE usePendingBatch because onDeliver (passed in below) resets it.
  // Safe today either way - onDeliver only runs from timers and effects, long
  // after this line - but a `const` read from a callback declared above it is a
  // latent TDZ the moment the hook grows any synchronous delivery path, and this
  // is a file where "reachable at the wrong point in the commit" was the bug
  // (CodeRabbit). Its refresh layout effect stays below, where pendingBatch is
  // in scope. See the block there for what it holds and why.
  const durabilityRef = useRef({
    ownerKey: null as string | null,
    paragraphs: [] as string[],
    dictated: false,
  });

  const { state: pendingBatch, onSubmit: batchOnSubmit, onType: batchOnType, sendNow: batchSendNow, cancel: batchCancel } =
    usePendingBatch(agent, {
      settleMs: batchPrefs.holdSeconds * 1000,
      // Every field comes from the delivery, none from render scope. `agent`
      // here is whichever thread is on screen when the delivery fires, which is
      // NOT reliably the thread the batch belongs to (see BatchDelivery).
      onDeliver: ({ body, targetAgent, dictated }: BatchDelivery) => {
        const fd = new FormData();
        fd.set("intent", "compose");
        fd.set("body", body);
        if (dictated) fd.set("dictated", "1");
        // TASK-500 #2a: the action reads targetAgent and writes to that inbox
        // instead of params.agent. Now set on EVERY delivery, not just
        // deliver-on-switch: the two agree in the normal case, and where they
        // disagree the owner is right and the mounted route is wrong.
        fd.set("targetAgent", targetAgent);
        batchFetcher.submit(fd, { method: "post" });
        // Delivered for real: drop the durability mirror so it can never be
        // resurrected on a later mount.
        clearBatch(targetAgent);
        // AND drop the in-memory snapshot immediately. Without this, a pagehide
        // firing in the gap before the reducer state re-renders would beacon the
        // same body a second time, duplicating a message that already landed.
        durabilityRef.current = { ownerKey: null, paragraphs: [], dictated: false };
      },
    });

  // --- Durability for the pre-delivery window (2026-07-26) -------------------
  // Between submit and settle the batch lives ONLY in this tab. Alex lost a
  // link that way: it was never written anywhere, so unlike the other two
  // delivery defects it left no artefact to find. See app/lib/batch-durability.
  // Carries ownerKey so the beacon addresses the batch it is actually holding.
  // Same hazard as the mirror, narrower window: this ref is only refreshed when
  // the batch state changes, so on a thread switch it still holds the OLD
  // thread's paragraphs for the gap between the commit and the passive-effect
  // flush that delivers them - and a visibilitychange landing in that gap used
  // to beacon them to the NEW thread.
  //
  // (The useRef itself is declared above the usePendingBatch call, so onDeliver
  // cannot capture it before initialisation.)
  //
  // Updated in a LAYOUT EFFECT, never during render. React can replay or
  // discard a render, and a ref written in the render body can therefore hold
  // a snapshot that was never committed - which pagehide would then send as if
  // it were the real batch (CodeRabbit).
  useLayoutEffect(() => {
    durabilityRef.current = {
      ownerKey: pendingBatch.ownerKey,
      paragraphs: pendingBatch.paragraphs,
      dictated: pendingBatch.dictated,
    };
  }, [pendingBatch.ownerKey, pendingBatch.paragraphs, pendingBatch.dictated]);

  // Recovery runs FIRST, and the mirror is gated behind it.
  //
  // CodeRabbit Critical 1: the mirror effect used to be declared above the
  // recovery effect. React runs mount effects in declaration order, and on
  // mount pendingBatch.paragraphs is [] (the hook knows nothing about a prior
  // session), so saveBatch fired with an empty array and cleared the very
  // record recovery was about to read. Closing the tab mid-compose and
  // reopening the SAME thread recovered nothing - which is precisely the
  // scenario this whole change exists for. Order alone was the entire defect.
  const recoveryDoneRef = useRef(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");

  useEffect(() => {
    // Clear the previous agent's notice before this agent's outcome is known.
    // The route component stays mounted across agent navigations (same reason
    // cancelRestoreDraft is cleared below), and setRecoveryNotice below only
    // fires on the recovered/expired branches - so switching to a thread with
    // nothing to recover would otherwise leave the previous agent's notice
    // showing, misattributed to this one.
    setRecoveryNotice("");
    // Per-agent (Critical 2): this route may only touch its own thread's batch.
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { recovered, expired } = takeRecoveredBatch(agent, Date.now(), token);

    if (recovered) {
      const fd = new FormData();
      fd.set("intent", "compose");
      fd.set("body", buildBatchBody(recovered.paragraphs));
      if (recovered.dictated) fd.set("dictated", "1");
      fd.set("targetAgent", recovered.agentKey);
      // Exactly one submit: scoping to a single agent also removes Major 1,
      // where consecutive submits on one fetcher aborted each other and the
      // notice claimed deliveries that never happened. A dedicated fetcher
      // (see recoveryFetcher above) also means this submit can never be
      // aborted by, or abort, an onDeliver submit on batchFetcher.
      recoveryFetcher.submit(fd, { method: "post" });
      setRecoveryNotice(
        "Recovered an unsent message from a previous session and delivered it now."
      );
    } else if (expired) {
      setRecoveryNotice(
        "Discarded an unsent message older than 24h without sending it."
      );
    }
    recoveryDoneRef.current = true;
  }, [agent, recoveryFetcher]);

  // Mirror on every change to the held paragraphs, but never before recovery
  // has had its turn on this thread, never when there is nothing to mirror, and
  // never a batch belonging to a thread other than the one rendered (see
  // shouldMirrorBatch's docstring for both hazards). The write is addressed by
  // the batch's own ownerKey inside mirrorPendingBatch, deliberately not from
  // `agent` here: passing the rendered agent as the storage key from this exact
  // line is what put thread A's text into thread B's slot.
  //
  // Deps are the three fields mirrorPendingBatch reads, deliberately NOT the
  // whole state object: a phase-only transition (TYPE -> SUSPENDED) would then
  // re-run this and re-stamp savedAt, which is the clock MIN_RECOVERY_AGE_MS
  // measures the "is this session still alive" floor from. Recovery timing is
  // out of scope here.
  useEffect(() => {
    mirrorPendingBatch(pendingBatch, recoveryDoneRef.current, agent, Date.now());
  }, [agent, pendingBatch.ownerKey, pendingBatch.paragraphs, pendingBatch.dictated]);

  // Beacon-flush when the page goes away. pagehide is the reliable signal on
  // mobile Safari (beforeunload does not fire when a tab is evicted), and
  // visibilitychange covers the app-switch case that does not unload at all.
  useEffect(() => {
    const flush = () => {
      const { ownerKey, paragraphs, dictated } = durabilityRef.current;
      if (!paragraphs.length) return;
      const body = buildBatchBody(paragraphs);
      // Addressed to the batch's owner, not the mounted thread. `agent` only
      // stands in if a batch somehow has no owner, which the reducer cannot
      // produce for a non-empty one.
      const owner = ownerKey ?? agent;
      // If the browser accepts the beacon the message is away, so the mirror
      // is redundant. If it refuses, the mirror is the whole safety net, which
      // is why it is left in place on failure.
      if (flushViaBeacon(window.location.pathname, body, dictated, owner)) {
        clearBatch(owner);
        durabilityRef.current = { ownerKey: null, paragraphs: [], dictated: false };
        // CodeRabbit Major 2: visibilitychange fires on an app switch WITHOUT
        // unloading, so the tab often survives. Left alone, the settle timer
        // keeps running in memory and onDeliver sends the same body a second
        // time. Cancelling the batch is what makes the beacon a handover
        // rather than a duplicate.
        batchCancel();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agent]);


  // TASK-500.5: when the user cancels a pending batch, capture the held text
  // BEFORE calling batchCancel (which resets paragraphs to []), then hand it
  // back to Compose via restoreDraft so the user can edit and resend rather
  // than having to retype.
  const [cancelRestoreDraft, setCancelRestoreDraft] = useState("");

  // Clear the cancel-restore draft whenever the active agent changes. The route
  // component stays mounted across agent navigations, so cancelRestoreDraft set
  // while viewing agent A would otherwise survive to agent B. When Compose
  // remounts after a tmux-toggle its lastRestoredRef resets to "", which lets
  // the stale value re-apply - painting agent A's draft into agent B's box.
  // Clearing here ensures the restore prop only ever carries text belonging to
  // the current agent's cancel action.
  useEffect(() => {
    setCancelRestoreDraft("");
  }, [agent]);

  const handleBatchCancel = useCallback(() => {
    const text = buildBatchBody(pendingBatch.paragraphs);
    batchCancel();
    // The mirror effect no longer clears on an empty batch (that implicit
    // clear was the source of the second-tab-clobbers-first-tab bug above),
    // so a genuine user cancel must clear its own mirror explicitly. Keyed by
    // the batch's owner: clearing by the rendered agent would leave the real
    // record behind for recovery to deliver a message the user just cancelled.
    clearBatch(pendingBatch.ownerKey ?? agent);
    if (text) setCancelRestoreDraft(text);
  }, [pendingBatch.paragraphs, pendingBatch.ownerKey, batchCancel, agent]);

  /** Called by Compose for each standard-mode submit (buffers into the batch). */
  const handleBatchSubmit = useCallback(
    (body: string, dictated: boolean) => {
      batchOnSubmit(body, dictated);
    },
    [batchOnSubmit]
  );

  // TASK-500.4: live draft preview. Tracks the in-progress composer text so the
  // pending bubble can show it while the user is typing a follow-up (SUSPENDED).
  // Only passed to the bubble components when livePreview pref is on AND the
  // batch is in SUSPENDED phase -- the gate is computed at render time below.
  const [liveDraft, setLiveDraft] = useState("");
  const livePreviewText =
    batchPrefs.livePreview && pendingBatch.phase === "SUSPENDED" ? liveDraft : "";

  // TASK-465 (working indicator, option A): the loader fingerprints the agent's
  // tmux pane while Alex's last message is unanswered. When that fingerprint
  // CHANGES between polls, the agent is stirring - show "working" on Alex's
  // last bubble for a short grace window, re-extended each poll the pane keeps
  // moving. Clears when the agent replies (the bubble is no longer the latest)
  // or the pane goes quiet for the grace window. Heuristic by design.
  const AGENT_WORKING_GRACE_MS = 6000;
  const prevPaneHashRef = useRef<string | null>(null);
  const [agentWorkingUntilMs, setAgentWorkingUntilMs] = useState(0);
  useEffect(() => {
    if (
      agentPaneHash !== null &&
      prevPaneHashRef.current !== null &&
      agentPaneHash !== prevPaneHashRef.current
    ) {
      setAgentWorkingUntilMs(Date.now() + AGENT_WORKING_GRACE_MS);
    }
    prevPaneHashRef.current = agentPaneHash;
  }, [agentPaneHash]);
  // Recomputed each poll re-render (loader `now` advances), so it clears within
  // one poll of the grace window expiring.
  const agentWorking = agentWorkingUntilMs > Date.now();

  // Callback passed into Markdown renderers so doc links open the panel.
  const handleOpenDoc = useCallback(
    (doc: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(DOC_PARAM, doc);
        return next;
      });
    },
    [setSearchParams]
  );

  function handleWriteOwn(decisionId: string) {
    setRespondingToDecisionId(decisionId);
    setCustomDraft("");
    // Focus the textarea after state update
    setTimeout(() => {
      const textarea = composeRef.current?.querySelector("textarea");
      if (textarea) textarea.focus();
    }, 50);
  }

  function handleSent() {
    setRespondingToDecisionId(undefined);
    setCustomDraft("");
  }

  function handleCancel() {
    setRespondingToDecisionId(undefined);
    setCustomDraft("");
  }

  // Deep-link from the needs-you bell: /threads/<agent>#<decisionId> scrolls
  // the target decision card into view inside the conversation pane.
  //
  // TASK-469: with the windowed loader the target can sit OUTSIDE the loaded
  // window (the hash never reaches the server). On a miss, set ?anchor=<id>
  // (replace - no history spam, hash preserved) so the loader extends the
  // window back to the card; this effect re-runs when the extended window
  // lands (startIndex dep) and scrolls. hashHandledRef stops later polls
  // re-yanking the viewport back to the card; an anchor param that STILL
  // finds nothing means the id is genuinely absent - no loop.
  const hashHandledRef = useRef("");
  useEffect(() => {
    if (!location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const handledKey = `${agent}#${id}`;
    if (hashHandledRef.current === handledKey) return;
    const el = document.getElementById(id);
    if (el) {
      hashHandledRef.current = handledKey;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (startIndex > 0 && searchParams.get("anchor") !== id) {
      const next = new URLSearchParams(searchParams);
      next.set("anchor", id);
      navigate(
        { search: `?${next.toString()}`, hash: location.hash },
        { replace: true, preventScrollReset: true }
      );
    }
  }, [location.hash, agent, startIndex, searchParams, navigate]);

  // ---------------------------------------------------------------------------
  // TASK-454: scroll-to-latest + conditional follow-bottom
  // ---------------------------------------------------------------------------
  // nearBottomRef tracks live scroll position; the effect below may only move
  // the viewport per shouldFollow's truth table (455 pin: NEVER yank the user
  // out of history). Keyed on a stable scalar so the 3s polls (TASK-455) only
  // re-fire it when content actually changes - the blocks array gets a new
  // identity every revalidation.
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  // Atlas fold: the route component stays MOUNTED across /threads/a ->
  // /threads/b (param change). "Initial" is per-AGENT, not per-mount, or
  // thread B silently loses its scroll-to-latest jump.
  const seenAgentRef = useRef<string | undefined>(undefined);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    nearBottomRef.current = isNearBottom(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight
    );
  }

  // TASK-469: keyed on totalCount (not the window length, which is capped at
  // the window limit) + the tail timestamp. Prepending older chunks changes
  // neither, so lazy-loading history NEVER fires the follow effect.
  const lastBlockTimestamp = blocks[blocks.length - 1]?.header.timestamp ?? "";
  const contentKey = `${totalCount}:${lastBlockTimestamp}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isInitial = seenAgentRef.current !== agent;
    // location.hash read at fire time, NOT a dep - a hash change must not
    // race a competing scroll against the deep-link effect above.
    const follow = shouldFollow({
      isInitial,
      hasHash: Boolean(window.location.hash),
      wasNearBottom: nearBottomRef.current,
    });
    seenAgentRef.current = agent;
    if (!follow) return;
    // Initial: land instantly on the latest message (no animation on load).
    // Updates: smooth-follow the conversation.
    el.scrollTo({ top: el.scrollHeight, behavior: isInitial ? "auto" : "smooth" });
    nearBottomRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, contentKey]);

  // ---------------------------------------------------------------------------
  // TASK-469: chunked lazy-load - retained blocks, load-older, scroll anchoring
  // ---------------------------------------------------------------------------

  // Retained blocks (older chunks + blocks that slid out of the live window).
  const [retained, setRetained] = useState<RetainedBlocks | null>(null);

  // Merge each live loader window into the retained map so a block that
  // falls out of the window when a new message appends stays mounted.
  // Bails out (returns prev = no re-render) when the map already covers the
  // window - the common 3s poll with no movement. Render always prefers the
  // FRESH loader copy for in-window blocks, so retained copies going stale
  // below the window is cosmetic only (an old status tick at worst).
  useEffect(() => {
    setRetained((prev) => {
      const sameAgent = prev !== null && prev.agent === agent;
      if (sameAgent) {
        let covered = true;
        for (let i = 0; i < blocks.length; i++) {
          if (!prev.map.has(startIndex + i)) {
            covered = false;
            break;
          }
        }
        if (covered) return prev;
      }
      const next = new Map(sameAgent ? prev.map : undefined);
      blocks.forEach((b, i) => next.set(startIndex + i, b));
      return { agent, map: next };
    });
  }, [agent, startIndex, blocks]);

  // Avatar URLs arriving with fetched chunks (the loader map only covers
  // senders in the live window). Merged at render time, loader copy wins.
  const [chunkAvatars, setChunkAvatars] = useState<{
    agent: string;
    map: Record<string, string>;
  } | null>(null);

  // The rendered list: retained blocks BELOW the live window (sorted by
  // absolute index), then the live window verbatim (fresh statuses/answers).
  const rendered = useMemo(() => {
    const out: Array<{ absIndex: number; block: WindowBlock }> = [];
    if (retained !== null && retained.agent === agent) {
      const below = [...retained.map.keys()]
        .filter((i) => i < startIndex)
        .sort((a, b) => a - b);
      for (const i of below) out.push({ absIndex: i, block: retained.map.get(i)! });
    }
    blocks.forEach((b, i) => out.push({ absIndex: startIndex + i, block: b }));
    return out;
  }, [retained, agent, startIndex, blocks]);
  const renderedBlocks = useMemo(() => rendered.map((r) => r.block), [rendered]);

  const oldestLoadedIndex = rendered.length > 0 ? rendered[0]!.absIndex : startIndex;
  const hasOlder = oldestLoadedIndex > 0;

  // Pending scroll adjustment for a prepend: captured just before the chunk
  // merges, applied in the layout effect below before the browser paints.
  const pendingScrollAdjustRef = useRef<{
    prevScrollHeight: number;
    prevScrollTop: number;
  } | null>(null);

  // Single-flight + fresh-closure refs for the IntersectionObserver callback
  // (the observer outlives renders; refs keep it reading current values).
  const loadingOlderRef = useRef(false);
  const loadOlderRef = useRef<() => void>(() => {});
  loadOlderRef.current = () => {
    if (loadingOlderRef.current || !hasOlder) return;
    // Hold fire until the initial scroll-to-latest has run for this agent -
    // the sentinel is momentarily visible at the un-scrolled top on mount.
    if (seenAgentRef.current !== agent) return;
    loadingOlderRef.current = true;
    const forAgent = agent;
    const before = oldestLoadedIndex;
    void (async () => {
      try {
        const res = await fetch(
          `/api/thread-window?agent=${encodeURIComponent(forAgent)}&before=${before}`
        );
        if (!res.ok) return;
        const chunk = (await res.json()) as ThreadWindowChunk;
        if (!chunk.ok || chunk.agent !== forAgent) return;
        // Discard if the user switched threads while the fetch was in flight.
        if (seenAgentRef.current !== forAgent) return;
        const el = scrollRef.current;
        if (el) {
          pendingScrollAdjustRef.current = {
            prevScrollHeight: el.scrollHeight,
            prevScrollTop: el.scrollTop,
          };
        }
        setRetained((prev) => {
          const sameAgent = prev !== null && prev.agent === forAgent;
          const next = new Map(sameAgent ? prev.map : undefined);
          chunk.blocks.forEach((b, i) => {
            const idx = chunk.startIndex + i;
            if (!next.has(idx)) next.set(idx, b);
          });
          return { agent: forAgent, map: next };
        });
        if (Object.keys(chunk.avatarUrls).length > 0) {
          setChunkAvatars((prev) => ({
            agent: forAgent,
            map:
              prev !== null && prev.agent === forAgent
                ? { ...prev.map, ...chunk.avatarUrls }
                : { ...chunk.avatarUrls },
          }));
        }
      } catch {
        // Network hiccup: stay quiet; the next intersection retries.
      } finally {
        loadingOlderRef.current = false;
      }
    })();
  };

  // Card-action staleness fix (2026-06-11 "clicking doesn't work" round two):
  // blocks BELOW the live window render from the retained map, which loader
  // revalidation never refreshes - so answering/doing/dismissing a card down
  // there left the stale unanswered copy on screen and the tap looked dead.
  // Watch the page's fetchers; when a card action completes, re-fetch the
  // below-window range and OVERWRITE the retained copies (unlike the
  // lazy-load merge, which deliberately skips existing keys).
  // TASK-475 (CodeRabbit, MR !32): an TASK-475 compose auto-resolve flips a card
  // in place too, so it joins this rising edge - but only that one, gated on
  // the action's return shape rather than the intent. See
  // refreshesRetainedBlocks.
  const fetchers = useFetchers();
  const cardActionInFlight = fetchers.some(refreshesRetainedBlocks);
  const prevCardActionRef = useRef(false);
  useEffect(() => {
    const justCompleted = prevCardActionRef.current && !cardActionInFlight;
    prevCardActionRef.current = cardActionInFlight;
    if (!justCompleted) return;
    const count = startIndex - oldestLoadedIndex;
    if (count <= 0) return;
    const forAgent = agent;
    const limit = Math.min(200, count);
    void (async () => {
      try {
        const res = await fetch(
          `/api/thread-window?agent=${encodeURIComponent(forAgent)}&before=${startIndex}&limit=${limit}`
        );
        if (!res.ok) return;
        const chunk = (await res.json()) as ThreadWindowChunk;
        if (!chunk.ok || chunk.agent !== forAgent) return;
        if (seenAgentRef.current !== forAgent) return;
        setRetained((prev) => {
          const sameAgent = prev !== null && prev.agent === forAgent;
          const next = new Map(sameAgent ? prev.map : undefined);
          chunk.blocks.forEach((b, i) => next.set(chunk.startIndex + i, b));
          return { agent: forAgent, map: next };
        });
      } catch {
        // Network hiccup: the stale copy survives until the next action or
        // thread re-open; never crash the thread over a refresh.
      }
    })();
  }, [cardActionInFlight, agent, startIndex, oldestLoadedIndex]);

  // Scroll anchoring: after a chunk prepends, restore the viewport so the
  // content the user was reading does not jump. Runs before paint.
  useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current;
    const el = scrollRef.current;
    if (!pending || !el) return;
    pendingScrollAdjustRef.current = null;
    el.scrollTop = pending.prevScrollTop + (el.scrollHeight - pending.prevScrollHeight);
  });

  // Top sentinel: entering the viewport (300px early) loads the previous
  // chunk. Re-armed whenever the oldest loaded index moves, so holding the
  // scroll at the very top cascades through history chunk by chunk.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root || !hasOlder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlderRef.current();
      },
      { root, rootMargin: "300px 0px 0px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [agent, hasOlder, oldestLoadedIndex, tmux]);

  // ---------------------------------------------------------------------------
  // Card-reply seed from the URL (?reply=<decisionId>)
  // ---------------------------------------------------------------------------
  // "OR write something..." on a card rendered INLINE in this thread just calls
  // handleWriteOwn on the already-mounted component, so nothing has to survive.
  // The same button on the CARDS TAB cannot do that: /cards and /threads/<agent>
  // are different route modules, so the click is a genuine cross-route
  // navigation and this component mounts FRESH with respondingToDecisionId back
  // at undefined. The user landed in the thread with an ordinary composer, typed
  // their answer, and it went out as a plain chat reply instead of the card's
  // option-C answer - no "Re: Decision: ... / Answered: X" receipt, and the card
  // still sitting there unanswered. Only the scroll position survived, because
  // ?anchor is the only thing the navigation carried that anyone read.
  //
  // WHY A DEDICATED PARAM RATHER THAN REUSING ?anchor. Two reasons, either one
  // sufficient:
  //  1. anchor is MACHINERY-OWNED. The deep-link effect above WRITES it on a
  //     scroll miss, for any /threads/<agent>#<decisionId> link - the needs-you
  //     bell being the common one. Seeding off anchor would drop the composer
  //     into card-reply mode every time someone followed a bell link to a card,
  //     which is a behaviour change well outside this bug.
  //  2. The two have opposite LIFETIMES. anchor must PERSIST for as long as the
  //     thread is open: it is a loader input, and dropping it shrinks the read
  //     window back to the tail, unmounting the very card being answered. The
  //     reply seed must be CONSUMED ONCE, or it drags the user back into reply
  //     mode after every cancel. One param cannot hold both lifetimes.
  //
  // CONSUME ONCE, then hand back to the normal clearing rules (handleSent,
  // handleCancel, and any per-agent reset): the param is stripped from the URL
  // the moment it is read, and the ref makes the read idempotent across the
  // renders between this effect firing and the replace navigation landing. The
  // ref is set BEFORE the validation, not after, so a seed that fails validation
  // is spent too - otherwise a later lazy-loaded history chunk containing the
  // card could snap the user into reply mode long after they arrived.
  //
  // VALIDATED, NOT TRUSTED: a decisionId in a query param is user input.
  // canSeedCardReply only says yes when this thread's loaded blocks actually
  // carry that card and it is still open. The Cards tab sends ?anchor= in the
  // same href, so the loader window already reaches back to the card on this
  // first render; a stale, answered or foreign id simply leaves the composer
  // ordinary.
  //
  // Declared HERE, below renderedBlocks (its validation input). No per-agent
  // clearing effect for respondingToDecisionId exists yet - that lands with
  // fix/compose-state-leaks-across-threads (unmerged). When it does, declare
  // it ABOVE this effect so a cross-agent navigation clears first and this
  // seeds after, never the other way round.
  const replySeedRef = useRef("");
  useEffect(() => {
    const replyId = searchParams.get(REPLY_PARAM);
    if (replyId === null || replyId === "") return;
    const seedKey = `${agent}:${replyId}`;
    if (replySeedRef.current === seedKey) return;
    replySeedRef.current = seedKey;

    if (canSeedCardReply(renderedBlocks, replyId)) {
      setRespondingToDecisionId(replyId);
      setCustomDraft("");
    }

    // Strip the spent seed. anchor and the hash are deliberately preserved:
    // anchor is the loader's window cursor and the hash is the scroll target.
    const next = new URLSearchParams(searchParams);
    next.delete(REPLY_PARAM);
    const nextSearch = next.toString();
    navigate(
      { search: nextSearch === "" ? "" : `?${nextSearch}`, hash: location.hash },
      { replace: true, preventScrollReset: true }
    );
  }, [agent, renderedBlocks, searchParams, navigate, location.hash]);

  // Find the subject of the card being responded to (for the "Responding to:" context label).
  const respondingCard = respondingToDecisionId
    ? renderedBlocks.find((b) => b.card?.decisionId === respondingToDecisionId)
    : undefined;
  const respondingSubject = respondingCard?.header.subject;

  // Both side panels live purely in the URL (?doc= / ?files=1), so navigating
  // away and back used to reset them to closed. This remembers them per thread
  // (sessionStorage, keyed by agent) and restores them on re-entry when the
  // incoming URL has no opinion of its own. Deliberately called here, after the
  // #anchor deep-link effect above: if both navigations land in the same commit
  // the anchor effect is the one that re-runs and re-applies (this hook restores
  // once per thread by design). Everything downstream keeps reading the search
  // params, unchanged.
  //
  // HELD WHILE ?reply= IS STILL IN THE URL. Both this hook and the seed-strip
  // effect directly above replace-navigate off a render-time searchParams
  // snapshot. On a card-reply link into a thread that has remembered panel
  // state they fire in the SAME effect flush, so neither snapshot carries the
  // other's pending edit: two navigations, last one wins, one edit lost. This
  // hook is the later one, so what survived was `?reply=<id>&doc=<path>` - the
  // spent seed written back into the URL, where replySeedRef (consume-once)
  // guarantees the strip never removes it again. Holding makes the two writes
  // sequential instead of racing: the strip lands, searchParams changes, this
  // effect wakes on the settled URL. The strip effect owns REPLY_PARAM's
  // lifetime, so the presence of the param IS "a strip is pending".
  usePersistedPanelState(agent, { hold: searchParams.has(REPLY_PARAM) });

  // File pinner: the Files panel is open when ?files=1 (read here so the thread
  // column can shrink to make room on desktop, same as the review panel does).
  const filesOpen = searchParams.get("files") === "1";
  const sidePanelOpen = Boolean(docParam) || filesOpen;

  return (
    // Outer flex row: thread column + optional review/files side panels.
    <div className="flex h-full">
      {/* Thread column - flex col, takes remaining space when no panel is open */}
      <div
        className={
          sidePanelOpen
            ? "flex min-w-0 flex-1 flex-col"
            : "flex h-full w-full flex-col"
        }
      >
        {/* TASK-454: header row + work-strip row removed - identity lives in
            the app bar (AppShell), the strip lives in the compose footer.
            Messages start at the top of the viewport. */}

        {/* TASK-437 amendment: terminal mode - the agent's live pane replaces
            the message history. v2: the pane is read/write - sendTarget wires
            the compose row to send-keys into this agent's live session. */}
        {tmux !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 py-4" data-testid="thread-tmux-view">
            <TmuxPane pane={tmux.pane} windowName={agent} sendTarget={agent} />
            <p className="label-mono mt-2 shrink-0 text-[10px] text-muted-foreground">
              Live terminal for {agent} - refreshes automatically; the box types
              into their session.
            </p>
          </div>
        ) : (
        <>
        {/* Scrollable message history - pb-28 ensures last message clears sticky compose */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-testid="thread-scroll"
          className="flex-1 overflow-y-auto px-6 pt-6 pb-28"
        >
          <div className="mx-auto max-w-2xl">
            {totalCount === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No messages in this thread"
                body="Send the first reply below."
              />
            ) : (
              <div className="flex flex-col">
                {/* TASK-469: top sentinel - scrolling it into view lazy-loads
                    the previous chunk of history. Doubles as the affordance. */}
                {hasOlder ? (
                  <div
                    ref={sentinelRef}
                    data-testid="load-older-sentinel"
                    className="label-mono py-3 text-center text-[10px] text-muted-foreground"
                  >
                    Loading earlier messages...
                  </div>
                ) : null}
                {rendered.map(({ absIndex, block }, index) => {
                  // THRD-02: the instance user's own blocks are visually distinguished.
                  const own = block.header.from === user;

                  // Day-divider before the first block, and whenever the
                  // London-local calendar day changes from the previous block.
                  // TASK-469: computed over the LOADED list - when an older
                  // chunk prepends, the old boundary recomputes naturally.
                  const prev = index > 0 ? rendered[index - 1]!.block : undefined;
                  const showDivider =
                    !prev ||
                    londonDayKey(prev.header.timestamp) !==
                      londonDayKey(block.header.timestamp);
                  // TASK-435.1: a malformed-timestamp block formats to "" -
                  // suppress the empty divider so a bad block does not leave a
                  // blank rule (the block itself still renders; cosmetic).
                  const dividerLabel = showDivider
                    ? formatDayDivider(block.header.timestamp, new Date(now))
                    : "";
                  const divider =
                    showDivider && dividerLabel !== "" ? (
                      <DayDivider label={dividerLabel} />
                    ) : null;

                  // CARD-01: card blocks render as interactive DecisionCard;
                  // action card blocks render as ActionCard;
                  // malformed cards fall back to plain bubble (card undefined
                  // after parser normalisation). THRD-03: plain blocks render
                  // as MessageBubble.
                  const isRespondingToThis =
                    block.card !== undefined &&
                    block.card.decisionId === respondingToDecisionId;

                  const content =
                    block.card !== undefined ? (
                      <DecisionCard
                        block={block}
                        now={now}
                        // postAction reveals Dismiss + Supersede inline here,
                        // same affordances the Cards tab has. It points at THIS
                        // route, which already handles all three intents.
                        // withDate is pinned false so the stamp stays the bare
                        // clock time every other bubble in the thread uses -
                        // postAction alone used to switch that format too.
                        postAction={`/threads/${agent}`}
                        withDate={false}
                        onWriteOwn={handleWriteOwn}
                        draftCustomAnswer={isRespondingToThis ? customDraft : undefined}
                        onOpenDoc={handleOpenDoc}
                      />
                    ) : block.actionCard !== undefined ? (
                      <ActionCard
                        block={block}
                        now={now}
                        postAction={`/threads/${agent}`}
                        withDate={false}
                        onOpenDoc={handleOpenDoc}
                      />
                    ) : (
                      <MessageBubble
                        own={own}
                        block={block}
                        now={now}
                        onOpenDoc={handleOpenDoc}
                        threadAgent={agent}
                        superseded={
                          own ? isSuperseded(renderedBlocks, index, user) : undefined
                        }
                        ticketColumn={
                          block.ticket !== undefined
                            ? (ticketColumns[block.ticket]?.column ?? undefined)
                            : undefined
                        }
                        avatarUrl={
                          own
                            ? undefined
                            : (avatarUrls[block.header.from] ??
                              (chunkAvatars !== null && chunkAvatars.agent === agent
                                ? chunkAvatars.map[block.header.from]
                                : undefined))
                        }
                        forceWorking={
                          own && index === rendered.length - 1 && agentWorking
                        }
                      />
                    );

                  // TASK-469: stable key - the absolute index prefix is stable
                  // (append-only file) and keeps the spec'd timestamp/from/id
                  // key unique when two plain messages share a second. A
                  // positional key would remount every card on each prepend.
                  const key = `${absIndex}:${block.header.timestamp}/${block.header.from}/${
                    block.card?.decisionId ?? block.actionCard?.actionId ?? "plain"
                  }`;
                  return (
                    <Fragment key={key}>
                      {divider}
                      {content}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* TASK-500: pending outbound batch indicator. Renders OUTSIDE the
            scroll area -- pinned between the end of the message list and the
            composer. TASK-500.1: display mode driven by batchPrefs.holdIndicator.
            Placement is the principal's design call; do not move without an
            explicit design decision. */}
        <div className="px-6">
          <div className="mx-auto max-w-2xl">
            {batchPrefs.holdIndicator === "pill" ? (
              <PendingBubble
                state={pendingBatch}
                onSendNow={batchSendNow}
                onCancel={handleBatchCancel}
                liveDraft={livePreviewText}
              />
            ) : batchPrefs.holdIndicator === "subtle" ? (
              <PendingStatusLine
                state={pendingBatch}
                onSendNow={batchSendNow}
                onCancel={handleBatchCancel}
                liveDraft={livePreviewText}
              />
            ) : null}
          </div>
        </div>

        {/* Recovered-batch notice. A rescued message must announce itself: a
            message arriving late with no explanation causes the same confusion
            as one that never arrived, from the other direction. */}
        {recoveryNotice ? (
          <div
            role="status"
            className="mx-3 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
          >
            {recoveryNotice}{" "}
            <button
              type="button"
              className="underline opacity-70 hover:opacity-100"
              onClick={() => setRecoveryNotice("")}
            >
              dismiss
            </button>
          </div>
        ) : null}

        {/* THRD-04: compose box pinned at the bottom of the thread */}
        <div ref={composeRef}>
          <Compose
            draftKey={agent}
            respondingToDecisionId={respondingToDecisionId}
            respondingToSubject={respondingSubject}
            value={respondingToDecisionId !== undefined ? customDraft : undefined}
            onChange={respondingToDecisionId !== undefined ? setCustomDraft : undefined}
            onSent={handleSent}
            onCancel={handleCancel}
            voiceProxyUrl={voice.proxyUrl}
            voiceDisabledReason={voice.disabledReason}
            debug={debugEnabled}
            onBatchSubmit={handleBatchSubmit}
            onBatchType={batchOnType}
            onBatchSendNow={batchSendNow}
            batchPrefs={batchPrefs}
            onBatchPrefsChange={setBatchPrefs}
            onDraftChange={setLiveDraft}
            restoreDraft={cancelRestoreDraft}
          />
        </div>
        </>
        )}
      </div>

      {/* TASK-431: Review panel (split on desktop, full-screen sheet on mobile) */}
      <ReviewPanel />

      {/* File pinner: per-thread Files panel (slide-out on desktop, sheet on
          mobile). Toggled by the AppShell Files button via ?files=1. */}
      <FilesPanel agent={agent} now={now} />
    </div>
  );
}

/**
 * Scoped error boundary (2026-06-11 lifeline hardening): a failure in this
 * route renders here, inside the shell - the sidebar and the rest of MC stay
 * usable. Real error text shown (tailnet-only internal tool).
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="this thread"
      hint="Other threads are unaffected - this one likely has a malformed block in its inbox file."
    />
  );
}
