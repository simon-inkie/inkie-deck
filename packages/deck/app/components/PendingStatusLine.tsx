/**
 * PendingStatusLine.tsx - Subtle pending batch indicator.
 *
 * Renders the held message as a teal-ringed bubble -- visually the same as a
 * delivered own-message but distinguished by a teal ring so it reads as
 * "pending, not yet sent". Replaces the plain grey status line that preceded it.
 *
 * Render rules:
 *   IDLE                     -> nothing (null)
 *   paragraphs.length === 0  -> nothing (null)
 *   PENDING                  -> teal bubble + pulsing "sending..." send-now button below
 *   SUSPENDED                -> teal bubble + "waiting for you to send" label below
 *
 * No .server imports. ASCII only.
 */
import type { PendingBatchState } from "~/lib/pending-batch";

interface PendingStatusLineProps {
  state: PendingBatchState;
  /** Called when the user taps the "sending..." button to deliver immediately. */
  onSendNow: () => void;
  /** Called when the user cancels the held batch (discards without sending). */
  onCancel: () => void;
  /**
   * Live draft text from the composer. When non-empty, rendered as
   * an additional in-progress paragraph after the held text (SUSPENDED only).
   */
  liveDraft?: string;
}

/**
 * Subtle pending batch bubble.
 *
 * Shows the held text as a normal teal bubble (teal ring marks it as pending)
 * with a quiet status footer underneath. Right-aligned to match own-message
 * layout.
 */
export function PendingStatusLine({ state, onSendNow, onCancel, liveDraft }: PendingStatusLineProps) {
  if (state.phase === "IDLE" || state.paragraphs.length === 0) return null;

  const isPending = state.phase === "PENDING";

  return (
    <div className="flex flex-col items-end mb-4" aria-live="polite">
      {/* Bubble body: same style as own MessageBubble; teal ring distinguishes
          pending from delivered (accent ring is pill mode's look -- never use
          ring-accent here). Full opacity: the text is legible and real. */}
      <div
        className="prose-mc max-w-prose px-4 py-2.5 bubble-own bg-primary text-primary-foreground rounded-2xl rounded-br-sm ring-2 ring-primary/60 ring-offset-1 ring-offset-background"
        data-testid="pending-subtle-bubble"
      >
        {state.paragraphs.map((para, i) => (
          <p
            key={i}
            className={i > 0 ? "mt-3 m-0" : "m-0"}
            style={{ whiteSpace: "pre-wrap" }}
          >
            {para}
          </p>
        ))}
        {/* Live draft -- shown while the user is typing a follow-up
            (SUSPENDED phase). Quieter opacity distinguishes in-progress text
            from the already-held paragraphs above. */}
        {liveDraft ? (
          <p
            className={state.paragraphs.length > 0 ? "mt-3 m-0 opacity-70" : "m-0 opacity-70"}
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="pending-live-draft"
          >
            {liveDraft}
          </p>
        ) : null}
      </div>

      {/* Status footer: quiet label below the bubble. */}
      <div className="mt-1 px-1 flex items-center gap-2">
        {isPending ? (
          <button
            type="button"
            onClick={onSendNow}
            data-testid="pending-status-send-now"
            title="Send now"
            aria-label="Sending, tap to send now"
            className="label-mono text-xs text-muted-foreground animate-pulse hover:text-foreground transition-colors"
          >
            sending...
          </button>
        ) : (
          <span className="label-mono text-xs text-muted-foreground">
            waiting for you to send
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          data-testid="pending-cancel"
          title="Unsend - return text to the compose box"
          aria-label="Unsend held messages"
          className="label-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          unsend
        </button>
      </div>
    </div>
  );
}
