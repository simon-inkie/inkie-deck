/**
 * MessageBubble.tsx - Plain markdown chat bubble for non-card message blocks.
 *
 * Renders a single message block as a chat bubble. The operator's own messages
 * (own=true) appear right-aligned with a distinct background; agent messages
 * appear left-aligned in a neutral style.
 *
 * Read receipts: own bubbles show a tick cluster beside the
 * timestamp - one tick (Check, muted) = sent, two ticks (CheckCheck,
 * primary) = read. The data is the existing header.status sent->read flip
 * (the flip IS the read receipt per SYSTEM.md inter-agent comms); this is
 * render-only. Unknown status values degrade to the sent tick - the
 * conservative direction for a receipt (never imply an unread message was
 * read). Agent bubbles carry no ticks v1.
 *
 * Working indicator: own bubbles with status: working show a
 * Loader2 spin icon and a "<agent> is on this" label. The indicator clears
 * (reverts to double tick) once a later agent reply supersedes it. The
 * superseded boolean and threadAgent name arrive as props from the thread
 * route (which has the full block list); bubbleReceiptState in working.ts
 * makes the single decision. Unknown status values degrade to sent tick.
 *
 * This is the plain bubble. Decision card rendering is Wave 3 -
 * this component intentionally handles only blocks where card is undefined.
 *
 * No .server imports - all data arrives via props.
 * ASCII only - no em-dashes.
 */
import { Check, CheckCheck, Loader2, Mic } from "lucide-react";
import { Link } from "react-router";
import { Avatar } from "./ui/avatar";
import type { MessageBlock } from "~/lib/blocks/model";
import { bubbleReceiptState, workingAgeSuffix } from "~/lib/blocks/working";
import { Badge } from "./ui/badge";
import { Markdown } from "./Markdown";
import { Timestamp } from "./Timestamp";

// Column -> Badge variant map (shared with CardDetail).
const COLUMN_VARIANT: Record<
  string,
  "default" | "secondary" | "warning" | "destructive" | "outline"
> = {
  todo: "secondary",
  "in progress": "default",
  blocked: "warning",
  "in review": "outline",
  done: "secondary",
};

interface MessageBubbleProps {
  /** Whether this block was sent by the operator (own=true) or the agent. */
  own: boolean;
  /** The message block to render. card must be undefined (use DecisionCard for cards). */
  block: MessageBlock;
  /** Server-side reference instant (ISO string) for relative timestamps. */
  now?: string;
  /**
   * Optional callback: called when the user clicks a review-openable link in
   * the message body. Wired from the thread route to open the review panel.
   */
  onOpenDoc?: (doc: string) => void;
  /**
   * The thread agent name (e.g. "scribe"). Used in the working indicator
   * label: "<threadAgent> is on this". Provided by the thread route.
   * Required for the working indicator to render; harmlessly absent for
   * non-own bubbles and when the feature is not needed.
   */
  threadAgent?: string;
  /**
   * Sender's avatar URL (/avatars/<from>?v=<mtime>) when the
   * sending agent has an avatar.png. Non-own bubbles only; initials disc
   * is the fallback inside Avatar itself.
   */
  avatarUrl?: string;
  /**
   * Whether this working-status block has been superseded by a later agent
   * reply in the thread. Computed by isSuperseded in threads.$agent.tsx and
   * passed as a primitive so MessageBubble stays a dumb renderer.
   * Defaults to false when absent (conservative: show indicator if working).
   */
  superseded?: boolean;
  /**
   * Optional column from the kanban card whose ticketId matches this
   * block's ticket field. Shown as a derived column Badge beside the ticket
   * chip when present AND the receipt state is not "working" (manual flip
   * takes precedence as the more specific signal).
   */
  ticketColumn?: string;
  /**
   * Force the "working" indicator on this bubble regardless of
   * block.status. Set by the thread route on the operator's LAST bubble when the
   * agent's tmux pane is actively stirring (heuristic working signal). Lets the
   * indicator show before any agent reply or status flip exists on disk.
   */
  forceWorking?: boolean;
}

/**
 * Chat bubble for a plain (non-card) message block.
 *
 * Layout: own messages sit on the right with a blue bubble; agent messages
 * sit on the left with a gray bubble. Both show the subject as a small label
 * above the body and a relative timestamp below.
 */
export function MessageBubble({ own, block, now, onOpenDoc, threadAgent, superseded = false, ticketColumn, avatarUrl, forceWorking = false }: MessageBubbleProps) {
  const alignClass = own ? "items-end" : "items-start";
  // Own bubbles are primary-teal: prose links (also teal) were invisible on
  // them. Fixed via the semantic bubble-own class +
  // .prose-mc.bubble-own a rule in app.css. Postmortem of two failed
  // arbitrary-variant attempts: [&_.prose-mc_a] never matched (the bubble
  // element ITSELF carries .prose-mc - no nested wrapper), and [&_a] tied
  // .prose-mc a on specificity (0,1,1) and lost on source order.
  const bubbleClass = own
    ? "bubble-own bg-primary text-primary-foreground rounded-2xl rounded-br-sm"
    : "bg-card text-card-foreground border border-border rounded-2xl rounded-bl-sm";

  // Derive the receipt state from block status + superseded flag.
  // bubbleReceiptState handles the working > read > sent precedence chain.
  // A live tmux-activity signal (forceWorking) shows "working" even
  // before any status flip exists on disk; otherwise fall back to the on-disk
  // receipt (working > read > sent).
  const receiptState = own
    ? forceWorking
      ? "working"
      : bubbleReceiptState(block, superseded)
    : null;

  // Working indicator label: "<agent> is on this", plus the message age when
  // older than an hour, so a crashed agent self-discloses instead of showing a
  // live indicator forever. Phrased as SENT age, never work duration.
  const ageSuffix =
    receiptState === "working"
      ? workingAgeSuffix(block.header.timestamp, now ? new Date(now) : new Date())
      : "";
  const workingLabel =
    (threadAgent ? `${threadAgent} is on this` : "Agent is on this") + ageSuffix;

  return (
    <div className={`flex flex-col ${alignClass} mb-4`}>
      <div className="mb-1 px-1 text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
        {/* Sender face on agent bubbles ("You" needs no face). */}
        {!own ? (
          <Avatar
            name={block.header.from}
            src={avatarUrl}
            className="h-5 w-5 text-[8px]"
          />
        ) : null}
        <span className="font-display font-bold uppercase tracking-tight">
          {own ? "You" : block.header.from}
        </span>
        {block.header.subject ? (
          <span className="text-muted-foreground">
            {block.header.subject}
          </span>
        ) : null}
        {block.ticket ? (
          <Link
            to={`/tickets/${block.ticket}`}
            data-testid="bubble-ticket-chip"
            className="label-mono rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground hover:bg-secondary/80"
          >
            {block.ticket}
          </Link>
        ) : null}
        {block.ticket && ticketColumn && receiptState !== "working" ? (
          <Badge
            variant={COLUMN_VARIANT[ticketColumn] ?? "secondary"}
            className="text-[10px] px-1.5 py-0"
            data-testid="bubble-ticket-column-badge"
          >
            {ticketColumn}
          </Badge>
        ) : null}
      </div>
      <div className={`mc-chat-message-copy prose-mc max-w-prose px-4 py-2.5 ${bubbleClass}`}>
        <Markdown onOpenDoc={onOpenDoc}>{block.body}</Markdown>
      </div>
      <div className="mt-1 flex items-center gap-1 px-1">
        <Timestamp iso={block.header.timestamp} now={now} />
        {/* Dictation provenance: mic glyph + label when the
            block carries the dictated: true meta line - tells the reader the
            text is transcribed speech and may carry transcription wonk. */}
        {/^dictated: true$/m.test(block.rawMeta) ? (
          <span
            title="Dictated - transcribed speech, wording may be imprecise"
            aria-label="Dictated message"
            data-testid="bubble-dictated"
            className="inline-flex items-center gap-0.5"
          >
            <Mic className="size-3 text-muted-foreground" aria-hidden="true" />
            <span className="label-mono text-[10px] text-muted-foreground">dictated</span>
          </span>
        ) : null}
        {receiptState === "working" ? (
          <span
            title={workingLabel}
            aria-label={workingLabel}
            data-testid="bubble-status-working"
            className="inline-flex items-center gap-1"
          >
            <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden="true" />
            <span className="label-mono text-xs text-accent">{workingLabel}</span>
          </span>
        ) : receiptState === "read" ? (
          <span
            title="Read"
            aria-label="Read"
            data-testid="bubble-status-tick"
            data-status="read"
            className="inline-flex"
          >
            <CheckCheck className="size-3.5 text-primary" aria-hidden="true" />
          </span>
        ) : receiptState === "sent" ? (
          <span
            title="Sent"
            aria-label="Sent"
            data-testid="bubble-status-tick"
            data-status="sent"
            className="inline-flex"
          >
            <Check className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </div>
  );
}
