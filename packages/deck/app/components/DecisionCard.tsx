/**
 * DecisionCard.tsx - Interactive decision card with tappable option buttons.
 *
 * Renders a decision card block with one button per option plus an
 * "OR write something..." affordance that opens a user-authored option C.
 * Each option button posts to the thread action via a fetcher
 * (no full-page navigation). After the action resolves, RR7 automatically
 * re-runs the loader so the answered badge appears without reload.
 *
 * RESOLVED card (answered or pushed back, TASK-453): receipt treatment -
 * title + resolution chip move INTO the header strip (chip prefers the
 * chosen option's LABEL over the bare letter when short - "Answered: Ship
 * it" beats "Answered: B" on a morning scan; Atlas fold), body collapses
 * to a two-line clamp, header strip toggles expansion. Expanded shows the
 * full body + the chosen/dimmed option rows (the record). No interactive
 * elements inside the header button (a11y pin).
 *
 * CARD-04: button values carry the stable decision-id, NOT a positional index.
 * CARD-06: answered cards stay visible (historical record).
 *
 * No .server imports - all data arrives via props (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */
import { useState } from "react";
import { useFetcher } from "react-router";
import { Check, CheckCircle2, ChevronDown, Pencil, Replace, Undo2, X, XCircle } from "lucide-react";
import type { MessageBlock } from "~/lib/blocks/model";
import { PUSHBACK_RESOLUTION, isCustomAnswer } from "~/lib/blocks/answer";
import { cn } from "~/lib/utils";
import { Markdown } from "./Markdown";
import { Timestamp } from "./Timestamp";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

interface DecisionCardProps {
  /** The message block containing the card data. card must be defined. */
  block: MessageBlock;
  /** Server-side reference instant (ISO string) for relative timestamps. */
  now?: string;
  /**
   * Called when the user clicks "OR write something...".
   * Receives the decisionId so the parent can lift state and focus Compose.
   */
  onWriteOwn?: (decisionId: string) => void;
  /**
   * When this card is the one being responded to, the parent passes the
   * live draft text here so we can show a live C-row preview.
   */
  draftCustomAnswer?: string;
  /**
   * Optional callback: called when the user clicks a review-openable link in
   * the card body. Wired from the thread route to open the review panel.
   */
  onOpenDoc?: (doc: string) => void;
  /**
   * Thread C: when set, card mutation forms POST to this path (the owning
   * agent's thread action, e.g. "/threads/scribe") instead of the current
   * route, and the additive Dismiss + Supersede affordances are revealed. The
   * Cards tab passes the same route it always did (a cross-route hand-off);
   * the thread view passes its own route too, so Dismiss + Supersede show
   * inline on unresolved cards there as well.
   */
  postAction?: string;
  /**
   * The dated stamp format, independent of postAction. Defaults to
   * Boolean(postAction) so the Cards tab keeps its dated stamps without
   * callers having to say so explicitly - but the thread view sets this to
   * false explicitly, because postAction there means "reveal Dismiss and
   * Supersede", not "also switch this card's timestamp format away from the
   * bare clock time every other bubble in the thread uses".
   */
  withDate?: boolean;
}

/**
 * Interactive decision card component.
 *
 * When the card has not been answered, renders tappable option buttons and
 * an "OR write something..." row that lifts route state (onWriteOwn callback).
 * When a draft is active (draftCustomAnswer set), a live C-row preview appears.
 *
 * When the card was answered with the user's own text, renders an extra row in
 * the chosen/filled state (user text as detail) and dims every option, since
 * none of them was picked. Tapped answers and pushback use the existing badge
 * rendering.
 *
 * The PUSHBACK_RESOLUTION const distinguishes a pushed-back badge from an
 * answered badge so the UI can show different copy for each state.
 */
export function DecisionCard({ block, now, onWriteOwn, draftCustomAnswer, onOpenDoc, postAction, withDate = Boolean(postAction) }: DecisionCardProps) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const card = block.card;
  // Resolved-card expansion (TASK-453): collapsed by default, throwaway UI state.
  const [expanded, setExpanded] = useState(false);
  const [showDismissForm, setShowDismissForm] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [showSupersedeForm, setShowSupersedeForm] = useState(false);
  const [supersedeNote, setSupersedeNote] = useState("");

  // card must be defined for this component to render correctly
  if (!card) return null;

  const isAnswered = card.answered !== undefined;
  const isPushedBack = card.answered === PUSHBACK_RESOLUTION;
  // Not "answered === C": that letter is a real option key on any card with
  // three or more of them, so the reader has to weigh the custom text too.
  const isCustom = isCustomAnswer(card);
  // Thread C: decisions gained dismiss + superseded terminal states.
  const lastIntent = fetcher.formData?.get("intent");
  const isDismissed = card.dismissed !== undefined || lastIntent === "dismissDecision";
  const isSuperseded = card.superseded !== undefined || lastIntent === "supersedeDecision";
  const isResolved = isAnswered || isDismissed || isSuperseded;

  // -------------------------------------------------------------------------
  // RESOLVED receipt (TASK-453; Thread C adds dismissed + superseded)
  // -------------------------------------------------------------------------
  if (isResolved) {
    // Chip text (Atlas fold): prefer the chosen option's label when short -
    // the bare letter means nothing without expanding. Fall back to the
    // letter when the label is long (or for custom answers beyond a glance).
    const chosenOption = card.options.find((o) => o.key === card.answered);
    const chosenLabel = isCustom ? card.customAnswer : chosenOption?.label;
    const answeredChipText =
      chosenLabel && chosenLabel.length <= 24
        ? `Answered: ${chosenLabel}`
        : `Answered: ${card.answered}`;
    // Thread C: dismissed / superseded resolve the card without an answer.
    const dataResolved = isPushedBack
      ? "pushback"
      : isAnswered
        ? "answered"
        : isDismissed
          ? "dismissed"
          : "superseded";

    return (
      <div
        id={card.decisionId}
        data-testid="decision-card"
        data-resolved={dataResolved}
        className="shadow-retro mb-4 scroll-mt-4 overflow-hidden rounded-lg border-2 border-primary/20 bg-card"
      >
        {/* Header strip as expand toggle - no nested interactive elements */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse card" : "Expand card"}
          data-testid="decision-card-toggle"
          className="flex min-h-11 w-full items-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-2 text-left hover:bg-primary/15 transition-colors"
        >
          <span className="label-mono shrink-0 text-primary">Decision</span>
          {/* Truncate only when collapsed (title= is mouse-only; expansion
              un-clamps for keyboard/touch readers - Atlas fold). */}
          <span
            className={cn(
              "min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-foreground",
              !expanded && "truncate"
            )}
            title={block.header.subject}
          >
            {block.header.subject}
          </span>
          {isPushedBack ? (
            <Badge variant="warning" className="shrink-0 gap-1" data-testid="decision-resolution-chip">
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              Pushed back
            </Badge>
          ) : isAnswered ? (
            <Badge variant="success" className="shrink-0 gap-1" data-testid="decision-resolution-chip">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {answeredChipText}
            </Badge>
          ) : isDismissed ? (
            <Badge variant="secondary" className="shrink-0 gap-1" data-testid="decision-resolution-chip">
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Dismissed
            </Badge>
          ) : (
            <Badge variant="secondary" className="shrink-0 gap-1" data-testid="decision-resolution-chip">
              <Replace className="h-3.5 w-3.5" aria-hidden="true" />
              Superseded
            </Badge>
          )}
          <Timestamp iso={block.header.timestamp} now={now} withDate={withDate} />
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
            aria-hidden="true"
          />
        </button>

        {/* Clamp region doubles as a pointer expand target (Alex live
            feedback) - keyboard semantics stay on the strip button. */}
        {!expanded ? (
          block.body ? (
            <div
              className="cursor-pointer px-4 py-3 hover:bg-muted/30 transition-colors"
              title="Expand"
              data-testid="decision-card-clamp"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a,button")) return;
                setExpanded(true);
              }}
            >
              <div className="prose-mc line-clamp-2 text-sm text-foreground/70">
                <Markdown onOpenDoc={onOpenDoc}>{block.body}</Markdown>
              </div>
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

            {/* Thread C: reason / note on a dismissed or superseded decision */}
            {isDismissed && card.dismissReason ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Reason: {card.dismissReason}
              </p>
            ) : null}
            {isSuperseded && card.supersedeNote ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Superseded: {card.supersedeNote}
              </p>
            ) : null}

            {/* The record: chosen option filled, others dimmed (CARD-06) */}
            <div className="mt-2 flex flex-col gap-2">
              {card.options.map((opt) => {
                const chosen = !isPushedBack && !isCustom && opt.key === card.answered;
                return (
                  <div
                    key={opt.key}
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-3 py-2 text-left",
                      chosen
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground opacity-60"
                    )}
                  >
                    {chosen ? (
                      <Check className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-xs">
                        {opt.key}
                      </span>
                    )}
                    <span className="flex-1">
                      <span className="font-medium">{opt.label}</span>
                      {opt.detail ? (
                        <span className="mt-0.5 block text-xs font-normal opacity-80">
                          {opt.detail}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}

              {isCustom && card.customAnswer !== undefined ? (
                <div className="flex items-start gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-left text-primary-foreground">
                  <Check className="mt-0.5 size-4 shrink-0" />
                  <span className="flex-1">
                    {/* Not "C": a card with three or more options has a real
                        option C sitting dimmed right above this row. */}
                    <span className="font-medium">Your answer</span>
                    <span className="mt-0.5 block text-xs font-normal opacity-90">
                      {card.customAnswer}
                    </span>
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      id={card.decisionId}
      data-testid="decision-card"
      className="shadow-retro mb-4 scroll-mt-4 overflow-hidden rounded-lg border-2 border-primary/30 bg-card"
    >
      {/* Card header row - teal banner so a "needs you" card reads as a physical card */}
      <div className="flex items-center justify-between border-b border-primary/20 bg-primary/10 px-4 py-2">
        <span className="label-mono text-primary">Decision</span>
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

        {/* Option buttons + write-own affordance (resolved cards return above) */}
        {(
          <div className="mt-2 flex flex-col gap-2">
            {card.options.map((opt) => (
              <fetcher.Form method="post" action={postAction} key={opt.key} className="contents">
                <input type="hidden" name="intent" value="answer" />
                <input
                  type="hidden"
                  name="decisionId"
                  value={card.decisionId}
                />
                <Button
                  type="submit"
                  name="answerKey"
                  value={opt.key}
                  variant="outline"
                  disabled={busy}
                  title={opt.detail || opt.label}
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left hover:border-primary hover:bg-primary/5"
                >
                  <span className="mr-2 font-mono font-bold text-primary">
                    {opt.key}
                  </span>
                  <span className="flex-1">
                    <span className="font-medium text-foreground">
                      {opt.label}
                    </span>
                    {opt.detail ? (
                      <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                        {opt.detail}
                      </span>
                    ) : null}
                  </span>
                </Button>
              </fetcher.Form>
            ))}

            {/* Live C-row preview when the user is drafting a custom answer */}
            {draftCustomAnswer !== undefined && draftCustomAnswer !== "" ? (
              <div
                data-testid="draft-c-row"
                className="flex items-start gap-2 rounded-md border border-primary/50 bg-primary/5 px-3 py-2 text-left"
              >
                <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-xs font-bold text-primary">
                  C
                </span>
                <span className="flex-1 text-sm text-foreground/80">
                  {draftCustomAnswer}
                </span>
              </div>
            ) : null}

            {/* "OR write something..." replaces the plain "Push back" button.
                Styled as a proper pressable row in the same button language as
                the A/B options (Alex's MC run-through feedback, 2026-06-06) -
                dashed border + pencil glyph signal "free-form" vs a canned option. */}
            <Button
              type="button"
              variant="outline"
              data-testid="write-own-btn"
              disabled={busy}
              onClick={() => onWriteOwn?.(card.decisionId)}
              className="mt-1 h-auto w-full justify-start whitespace-normal border-dashed py-2 text-left text-muted-foreground hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Pencil className="mr-2 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="label-mono text-xs">OR write something...</span>
            </Button>

            {/* Thread C: Dismiss + Supersede - additive, shown on unresolved
                cards wherever postAction is set (Cards tab and thread view).
                Close a stale decision without round-tripping the agent. */}
            {postAction ? (
              <div className="mt-1 flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="decision-dismiss-btn"
                  disabled={busy}
                  onClick={() => {
                    setShowDismissForm((v) => !v);
                    setShowSupersedeForm(false);
                  }}
                  className="h-auto py-1 text-xs text-muted-foreground hover:text-destructive"
                >
                  <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Dismiss
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="decision-supersede-btn"
                  disabled={busy}
                  onClick={() => {
                    setShowSupersedeForm((v) => !v);
                    setShowDismissForm(false);
                  }}
                  className="h-auto py-1 text-xs text-muted-foreground hover:text-primary"
                >
                  <Replace className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Supersede
                </Button>
              </div>
            ) : null}

            {/* Inline dismiss form */}
            {showDismissForm && postAction ? (
              <fetcher.Form
                method="post"
                action={postAction}
                className="mt-1 flex items-center gap-2"
                onSubmit={() => setShowDismissForm(false)}
              >
                <input type="hidden" name="intent" value="dismissDecision" />
                <input type="hidden" name="decisionId" value={card.decisionId} />
                <input
                  type="text"
                  name="reason"
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  placeholder={`Why not? (optional - travels back to ${block.header.from})`}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="decision-dismiss-reason-input"
                />
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  data-testid="decision-dismiss-confirm-btn"
                >
                  Dismiss
                </Button>
              </fetcher.Form>
            ) : null}

            {/* Inline supersede form */}
            {showSupersedeForm && postAction ? (
              <fetcher.Form
                method="post"
                action={postAction}
                className="mt-1 flex items-center gap-2"
                onSubmit={() => setShowSupersedeForm(false)}
              >
                <input type="hidden" name="intent" value="supersedeDecision" />
                <input type="hidden" name="decisionId" value={card.decisionId} />
                <input
                  type="text"
                  name="note"
                  value={supersedeNote}
                  onChange={(e) => setSupersedeNote(e.target.value)}
                  placeholder={`Superseded by? (optional - travels back to ${block.header.from})`}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="decision-supersede-note-input"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-testid="decision-supersede-confirm-btn"
                >
                  Supersede
                </Button>
              </fetcher.Form>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
