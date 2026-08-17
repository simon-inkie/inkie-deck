/**
 * ActionCard.tsx - Interactive action card with a single DONE tick button.
 *
 * Same chrome as DecisionCard: shadow-retro, banner header, card shape.
 * Burnt-orange accent (Inkie accent colour) instead of teal to read as
 * "do this with your hands" vs "decide this".
 *
 * LIVE card: title in the body, footer row (avatar + staleness + priority +
 * ticket), 44px tick + dismiss X controls.
 *
 * RESOLVED card (done or dismissed, TASK-453): the card becomes a RECEIPT -
 * title moves INTO the header strip alongside an obvious resolution chip
 * (tick + "Done 7h ago" / "Dismissed 2h ago") and the timestamp; the body
 * collapses to a two-line clamp; dead controls are REMOVED, not disabled
 * (a disabled control says "exists but you cannot" - wrong message for a
 * completed action; the chip carries the indication). The header strip is
 * a button toggling expansion: expanded shows the full body, done-note /
 * dismiss-reason, the meta footer, and the still-live "+ add note"
 * affordance. CARD-06 (resolved cards stay visible) untouched.
 *
 * body rendered via Markdown; onOpenDoc passthrough like DecisionCard.
 *
 * No .server imports - all data arrives via props (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */
import { useState } from "react";
import { useFetcher } from "react-router";
import { Check, CheckCircle2, ChevronDown, ExternalLink, Replace, X, XCircle } from "lucide-react";
import { formatRelative } from "~/lib/time";
import type { MessageBlock } from "~/lib/blocks/model";
import { cn } from "~/lib/utils";
import { Markdown } from "./Markdown";
import { Timestamp } from "./Timestamp";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface ActionCardProps {
  /** The message block containing the actionCard data. actionCard must be defined. */
  block: MessageBlock;
  /** Server-side reference instant (ISO string) for relative timestamps. */
  now?: string;
  /**
   * Optional callback: called when the user clicks a review-openable link in
   * the card body. Wired from the thread route to open the review panel.
   */
  onOpenDoc?: (doc: string) => void;
  /**
   * Thread C: when set, card mutation forms POST to this path (the owning
   * agent's thread action, e.g. "/threads/scribe") instead of the current
   * route, and the additive Supersede affordance is revealed. The Cards tab
   * passes the same route it always did (a cross-route hand-off); the thread
   * view passes its own route too, so Supersede shows inline on unresolved
   * cards there as well.
   */
  postAction?: string;
  /**
   * The dated stamp format, independent of postAction. Defaults to
   * Boolean(postAction) so the Cards tab keeps its dated stamps without
   * callers having to say so explicitly - but the thread view sets this to
   * false explicitly, because postAction there means "reveal Supersede", not
   * "also switch this card's timestamp format away from the bare clock time
   * every other bubble in the thread uses".
   */
  withDate?: boolean;
}

/**
 * Interactive action card component.
 *
 * When the action is not yet done, renders a DONE tick button (44px).
 * When the action is already done, renders a "Done <time>" success badge with
 * the tick disabled (card stays visible as historical record, CARD-06).
 */
export function ActionCard({ block, now, onOpenDoc, postAction, withDate = Boolean(postAction) }: ActionCardProps) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const actionCard = block.actionCard;
  const [showDismissForm, setShowDismissForm] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [showSupersedeForm, setShowSupersedeForm] = useState(false);
  const [supersedeNote, setSupersedeNote] = useState("");
  // Resolved-card expansion (TASK-453): collapsed by default, throwaway UI state.
  const [expanded, setExpanded] = useState(false);

  if (!actionCard) return null;

  const isDone = actionCard.done !== undefined;
  const isDismissed = actionCard.dismissed !== undefined;
  const isSuperseded = actionCard.superseded !== undefined;

  // Optimistic done state: if the fetcher just submitted done, treat as done.
  const lastIntent = fetcher.formData?.get("intent");
  const optimisticDone = isDone || lastIntent === "done";
  // Optimistic dismissed state.
  const optimisticDismissed = isDismissed || lastIntent === "dismiss";
  // Optimistic superseded state (Thread C).
  const optimisticSuperseded = isSuperseded || lastIntent === "supersedeAction";

  // Waiting duration: from block filed-at to now.
  // formatRelative (time.ts) is the guarded helper: a malformed timestamp on
  // EITHER side returns "" instead of throwing "Invalid time value" and
  // killing the whole page render (2026-06-11 lifeline hardening). The nowDate
  // candidate itself is also coalesced - a garbage `now` prop must not crash.
  const nowCandidate = now ? new Date(now) : new Date();
  const nowDate = Number.isNaN(nowCandidate.getTime()) ? new Date() : nowCandidate;
  const waitingDisplay = formatRelative(block.header.timestamp, nowDate);

  // Done relative time label ("" -> caller fallback "just now").
  const doneDisplay = actionCard.done
    ? formatRelative(actionCard.done, nowDate) || null
    : null;

  // Dismissed relative time label.
  const dismissedDisplay = actionCard.dismissed
    ? formatRelative(actionCard.dismissed, nowDate) || null
    : null;

  // Superseded relative time label.
  const supersededDisplay = actionCard.superseded
    ? formatRelative(actionCard.superseded, nowDate) || null
    : null;

  const resolved = optimisticDone || optimisticDismissed || optimisticSuperseded;

  // -------------------------------------------------------------------------
  // RESOLVED receipt (TASK-453): header strip carries label + title + chip +
  // time + chevron; body clamps; dead controls removed.
  // -------------------------------------------------------------------------
  if (resolved) {
    return (
      <div
        id={actionCard.actionId}
        data-testid="action-card"
        data-resolved={optimisticDone ? "done" : optimisticDismissed ? "dismissed" : "superseded"}
        className="shadow-retro mb-4 scroll-mt-4 overflow-hidden rounded-lg border-2 border-accent/30 bg-card"
      >
        {/* Header strip as expand toggle: label -> title -> outcome -> when */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse card" : "Expand card"}
          data-testid="action-card-toggle"
          className="flex min-h-11 w-full items-center gap-2 border-b border-accent/20 bg-accent/10 px-4 py-2 text-left hover:bg-accent/15 transition-colors"
        >
          {/* Label in the accent hue (Alex live feedback: the foreground-on-
              tint read as washed-out white) - matches Decision's text-primary. */}
          <span className="label-mono shrink-0 text-accent">Action</span>
          {/* Atlas fold: truncate only when collapsed - title= is mouse-only,
              so expansion un-clamps the title for keyboard/touch readers. */}
          <span
            className={cn(
              "min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-foreground",
              !expanded && "truncate"
            )}
            title={block.header.subject}
          >
            {block.header.subject}
          </span>
          {optimisticDone ? (
            <Badge variant="success" className="shrink-0 gap-1" data-testid="action-done-badge">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Done {doneDisplay ?? "just now"}
            </Badge>
          ) : optimisticDismissed ? (
            <Badge variant="secondary" className="shrink-0 gap-1" data-testid="action-dismissed-badge">
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Dismissed {dismissedDisplay ?? "just now"}
            </Badge>
          ) : (
            <Badge variant="secondary" className="shrink-0 gap-1" data-testid="action-superseded-badge">
              <Replace className="h-3.5 w-3.5" aria-hidden="true" />
              Superseded {supersededDisplay ?? "just now"}
            </Badge>
          )}
          <Timestamp iso={block.header.timestamp} now={now} withDate={withDate} />
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
            aria-hidden="true"
          />
        </button>

        {/* Collapsed: two-line clamped description. Expanded: the full record.
            The clamp region is a pointer-convenience expand target (Alex live
            feedback: "clicking anywhere on the done card body expands it") -
            keyboard semantics stay on the strip button; links inside the
            clamp keep working via the closest() guard. */}
        {!expanded ? (
          block.body ? (
            <div
              className="cursor-pointer px-4 py-3 hover:bg-muted/30 transition-colors"
              title="Expand"
              data-testid="action-card-clamp"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a,button")) return;
                setExpanded(true);
              }}
            >
              <div className="prose-mc line-clamp-2 text-sm text-foreground/70">
                <Markdown onOpenDoc={onOpenDoc}>{block.body}</Markdown>
              </div>
              {/* Visible affordance: this is expandable */}
              <span className="mt-1 flex items-center justify-end gap-0.5 label-mono text-[10px] text-muted-foreground">
                more
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </span>
            </div>
          ) : null
        ) : (
          <div className="p-4">
            {block.body ? (
              <div className="prose-mc mb-4 text-sm text-foreground/80">
                <Markdown onOpenDoc={onOpenDoc}>{block.body}</Markdown>
              </div>
            ) : null}

            {/* Feedback already on the record */}
            {optimisticDismissed && actionCard.dismissReason ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Reason: {actionCard.dismissReason}
              </p>
            ) : null}
            {optimisticDone && actionCard.doneNote ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Note: {actionCard.doneNote}
              </p>
            ) : null}
            {optimisticSuperseded && actionCard.supersedeNote ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Superseded: {actionCard.supersedeNote}
              </p>
            ) : null}

            {/* Meta footer (no controls - the chip is the state) */}
            <div className="flex items-center gap-2 flex-wrap">
              <Avatar name={block.header.from} className="h-6 w-6 text-xs" />
              <span className="text-xs text-muted-foreground">{waitingDisplay}</span>
              {actionCard.priority ? (
                <Badge
                  variant={actionCard.priority.toLowerCase() === "high" ? "destructive" : "secondary"}
                  className="text-xs"
                >
                  {actionCard.priority}
                </Badge>
              ) : null}
              {actionCard.ticket ? (
                <a
                  href={actionCard.ticket}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Ticket
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
              <span className="flex-1" />
              {/* The one still-live affordance: add a done note (TASK-440) */}
              {optimisticDone && !actionCard.doneNote && !showNoteForm ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs h-auto py-0.5 px-1.5"
                  data-testid="action-add-note-btn"
                  onClick={() => setShowNoteForm(true)}
                >
                  + add note
                </Button>
              ) : null}
            </div>

            {/* Done note inline form */}
            {showNoteForm && optimisticDone && !actionCard.doneNote ? (
              <fetcher.Form
                method="post"
                action={postAction}
                className="mt-3 flex items-center gap-2"
                onSubmit={() => setShowNoteForm(false)}
              >
                <input type="hidden" name="intent" value="doneNote" />
                <input type="hidden" name="actionId" value={actionCard.actionId} />
                <input
                  type="text"
                  name="note"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note..."
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="action-note-input"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy || noteText.trim().length === 0}
                  data-testid="action-note-submit-btn"
                >
                  Save note
                </Button>
              </fetcher.Form>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // LIVE card: unchanged layout - big title, prominent controls.
  // -------------------------------------------------------------------------
  return (
    <div
      id={actionCard.actionId}
      data-testid="action-card"
      className="shadow-retro mb-4 scroll-mt-4 overflow-hidden rounded-lg border-2 border-accent/50 bg-card"
    >
      {/* Card header row - burnt-orange accent banner. Label in the accent
          hue (Alex live feedback, TASK-453) - same treatment as the receipt. */}
      <div className="flex items-center justify-between border-b border-accent/20 bg-accent/10 px-4 py-2">
        <span className="label-mono text-accent">Action</span>
        <Timestamp iso={block.header.timestamp} now={now} withDate={withDate} />
      </div>

      <div className="p-4">
        {/* Subject */}
        <p className="mb-2 font-display text-base font-bold tracking-tight text-foreground">
          {block.header.subject}
        </p>

        {/* Card body (agent-authored, sanitized via Markdown) */}
        {block.body ? (
          <div className="prose-mc mb-4 text-sm text-foreground/80">
            <Markdown onOpenDoc={onOpenDoc}>{block.body}</Markdown>
          </div>
        ) : null}

        {/* Footer row: avatar + staleness + priority + ticket + controls */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Avatar name={block.header.from} className="h-6 w-6 text-xs" />

          <span className="text-xs text-muted-foreground">
            {waitingDisplay}
          </span>

          {actionCard.priority ? (
            <Badge
              variant={actionCard.priority.toLowerCase() === "high" ? "destructive" : "secondary"}
              className="text-xs"
            >
              {actionCard.priority}
            </Badge>
          ) : null}

          {actionCard.ticket ? (
            <a
              href={actionCard.ticket}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Ticket
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : null}

          {/* Spacer */}
          <span className="flex-1" />

          {/* Default state: tick + dismiss X */}
          {(
            <div className="flex items-center gap-1">
              <fetcher.Form method="post" action={postAction}>
                <input type="hidden" name="intent" value="done" />
                <input type="hidden" name="actionId" value={actionCard.actionId} />
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  disabled={busy}
                  aria-label="Mark as done"
                  data-testid="action-done-btn"
                  className={cn(
                    "h-11 w-11 shrink-0 rounded-full border-2 border-accent/50",
                    "hover:border-accent hover:bg-accent hover:text-accent-foreground",
                    "transition-colors"
                  )}
                >
                  <Check className="h-5 w-5" aria-hidden="true" />
                </Button>
              </fetcher.Form>
              {/* Dismiss X button */}
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={busy}
                aria-label="Dismiss action"
                data-testid="action-dismiss-btn"
                onClick={() => setShowDismissForm((v) => !v)}
                className={cn(
                  "h-11 w-11 shrink-0 rounded-full border-2 border-muted",
                  "hover:border-destructive hover:bg-destructive/10 hover:text-destructive",
                  "transition-colors"
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
              {/* Thread C: Supersede button - additive, shown on unresolved
                  cards wherever postAction is set (Cards tab and thread view).
                  Marks the action replaced by a newer one. */}
              {postAction ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={busy}
                  aria-label="Supersede action"
                  data-testid="action-supersede-btn"
                  onClick={() => setShowSupersedeForm((v) => !v)}
                  className={cn(
                    "h-11 w-11 shrink-0 rounded-full border-2 border-muted",
                    "hover:border-primary hover:bg-primary/10 hover:text-primary",
                    "transition-colors"
                  )}
                >
                  <Replace className="h-5 w-5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {/* Inline dismiss form (revealed by X click) */}
        {showDismissForm && !optimisticDone && !optimisticDismissed ? (
          <fetcher.Form
            method="post"
            action={postAction}
            className="mt-3 flex items-center gap-2"
            onSubmit={() => setShowDismissForm(false)}
          >
            <input type="hidden" name="intent" value="dismiss" />
            <input type="hidden" name="actionId" value={actionCard.actionId} />
            <input
              type="text"
              name="reason"
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder={`Why not? (optional - travels back to ${block.header.from})`}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="action-dismiss-reason-input"
            />
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={busy}
              data-testid="action-dismiss-confirm-btn"
            >
              Dismiss
            </Button>
          </fetcher.Form>
        ) : null}

        {/* Inline supersede form (Thread C, revealed by the Supersede button) */}
        {showSupersedeForm && postAction && !resolved ? (
          <fetcher.Form
            method="post"
            action={postAction}
            className="mt-3 flex items-center gap-2"
            onSubmit={() => setShowSupersedeForm(false)}
          >
            <input type="hidden" name="intent" value="supersedeAction" />
            <input type="hidden" name="actionId" value={actionCard.actionId} />
            <input
              type="text"
              name="note"
              value={supersedeNote}
              onChange={(e) => setSupersedeNote(e.target.value)}
              placeholder={`Superseded by? (optional - travels back to ${block.header.from})`}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="action-supersede-note-input"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid="action-supersede-confirm-btn"
            >
              Supersede
            </Button>
          </fetcher.Form>
        ) : null}

      </div>
    </div>
  );
}
