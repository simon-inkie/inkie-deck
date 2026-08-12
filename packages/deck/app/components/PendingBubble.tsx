/**
 * PendingBubble.tsx - Visual pending batch pseudo-bubble (TASK-500).
 *
 * Renders inline in the message list above the composer when there is a
 * non-IDLE pending batch. Shows the accumulated message text with a state
 * badge indicating whether the batch is about to settle (holding) or is
 * hard-suspended because the user is typing (editing).
 *
 * The bubble intentionally mirrors the own-message MessageBubble style so it
 * reads naturally as a message already in the thread, just not yet delivered.
 *
 * Tapping the "holding" badge calls onSendNow (send-now override, double-Enter
 * also works in Compose). The "editing" indicator has no tap target - it just
 * signals that the current draft must be submitted before delivery resumes.
 *
 * No .server imports - all data arrives via props (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */
import { Clock, Pencil, X } from "lucide-react";
import { Badge } from "./ui/badge";
import type { PendingBatchState } from "~/lib/pending-batch";
import { cn } from "~/lib/utils";

interface PendingBubbleProps {
  state: PendingBatchState;
  /** Called when the user taps the "holding" badge to deliver immediately. */
  onSendNow: () => void;
  /** Called when the user cancels the held batch (discards without sending). */
  onCancel: () => void;
  /**
   * TASK-500.4: Live draft text from the composer. When non-empty, rendered as
   * an additional in-progress paragraph after the held text (SUSPENDED only).
   */
  liveDraft?: string;
}

/**
 * Pending outbound batch pseudo-bubble.
 *
 * Renders only when phase !== "IDLE" and there is at least one paragraph.
 * The badge communicates the sub-state:
 *   PENDING    -> "holding, tap to send now" (settle timer running)
 *   SUSPENDED  -> "editing" (settle timer paused; a draft is in progress)
 */
export function PendingBubble({ state, onSendNow, onCancel, liveDraft }: PendingBubbleProps) {
  if (state.phase === "IDLE" || state.paragraphs.length === 0) return null;

  const isPending = state.phase === "PENDING";

  return (
    <div
      className="flex flex-col items-end mb-4"
      data-testid="pending-bubble"
      aria-live="polite"
      aria-label="Message pending delivery"
    >
      {/* Label row: mirrors MessageBubble header row */}
      <div className="mb-1 px-1 text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
        <span className="font-display font-bold uppercase tracking-tight">You</span>
        {isPending ? (
          /* Tappable badge: tap to deliver immediately (send-now override). */
          <button
            type="button"
            onClick={onSendNow}
            data-testid="pending-badge-send-now"
            title="Send now - skip the settle window"
            aria-label="Holding - tap to send now"
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
              "border-accent/40 bg-accent/10 text-accent",
              "hover:bg-accent/20 transition-colors cursor-pointer"
            )}
          >
            <Clock className="size-3" aria-hidden="true" />
            holding, tap to send now
          </button>
        ) : (
          /* Non-interactive badge: shows "editing" while draft is in progress. */
          <Badge
            variant="outline"
            className="gap-1 border-muted-foreground/30 text-muted-foreground"
            data-testid="pending-badge-editing"
          >
            <Pencil className="size-3" aria-hidden="true" />
            editing...
          </Badge>
        )}
        {/* Cancel button: always available in PENDING and SUSPENDED. Quiet
            register - same muted palette as the editing badge. */}
        <button
          type="button"
          onClick={onCancel}
          data-testid="pending-cancel"
          title="Unsend - return text to the compose box"
          aria-label="Unsend held messages"
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-xs",
            "border-muted-foreground/20 text-muted-foreground",
            "hover:border-muted-foreground/40 hover:text-foreground transition-colors cursor-pointer"
          )}
        >
          <X className="size-3" aria-hidden="true" />
          unsend
        </button>
      </div>

      {/* Bubble body: same style as own MessageBubble but visually softened
          (reduced opacity) to distinguish pending from delivered. A ring
          border makes the held/editing state unmistakable at a glance:
          accent ring while holding (settle timer running), muted ring while
          editing (hard-suspended, draft in progress). */}
      <div
        className={cn(
          "prose-mc max-w-prose px-4 py-2.5",
          "bubble-own bg-primary text-primary-foreground rounded-2xl rounded-br-sm",
          "opacity-70",
          isPending
            ? "ring-2 ring-accent/60 ring-offset-1 ring-offset-background"
            : "ring-2 ring-muted-foreground/30 ring-offset-1 ring-offset-background"
        )}
        data-testid="pending-bubble-body"
      >
        {/* Render paragraphs preserving message boundaries. Use pre-wrap so
            line-breaks within a paragraph are also honoured. */}
        {state.paragraphs.map((para, i) => (
          <p
            key={i}
            className={cn("m-0", i > 0 && "mt-3")}
            style={{ whiteSpace: "pre-wrap" }}
          >
            {para}
          </p>
        ))}
        {/* TASK-500.4: live draft -- shown while the user is typing a follow-up
            (SUSPENDED phase). Visually quieter (opacity-70) to distinguish
            in-progress text from the already-held paragraphs above. */}
        {liveDraft ? (
          <p
            className={cn("m-0 opacity-70", state.paragraphs.length > 0 && "mt-3")}
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="pending-live-draft"
          >
            {liveDraft}
          </p>
        ) : null}
      </div>

      {/* Footer: "not yet delivered" label so there is no ambiguity. */}
      <div className="mt-1 px-1">
        <span className="label-mono text-[10px] text-muted-foreground">
          {isPending ? "sending after a short pause..." : "waiting for you to send"}
        </span>
      </div>
    </div>
  );
}
