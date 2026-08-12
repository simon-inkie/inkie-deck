/**
 * CardDetail.tsx - Card detail overlay for the Projects board (TASK-439).
 *
 * Triggered by ?card=<cardId> URL search param on /projects.
 *
 * Desktop (md+): centred modal dialog (Dialog component from Radix-free
 * implementation below) over the board. Board context stays visible behind.
 * Mobile (<md): full-screen sheet (fixed inset-0 overlay).
 *
 * One component, one implementation - the same JSX structure for both,
 * switched by tailwind responsive prefixes.
 *
 * Content:
 *   - Title (font-display)
 *   - Agent Avatar + name
 *   - Column Badge
 *   - Staleness + updated date
 *   - Optional ticket link-out (ExternalLink)
 *   - links: asset-chip row (ReviewableChip per link)
 *   - Body rendered via Markdown + .prose-mc, onOpenDoc wired
 *
 * ?card= / ?doc= interaction rule (TASK-439, Atlas retained-param fold):
 *   Opening a doc from the detail SETS ?doc= and RETAINS ?card=. The
 *   doc-wins render precedence shows the panel and keeps the detail closed;
 *   closing the panel removes ?doc= and the retained ?card= RESTORES the
 *   detail - the open-card -> open-SPEC -> close-SPEC journey lands back ON
 *   THE CARD, not on the bare board. One render rule covers hand-crafted
 *   both-set URLs identically.
 *
 * Close: clears ?card= (back button on mobile, X on desktop).
 *
 * No .server imports - FND-02. ASCII only - no em-dashes - FND-05.
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { X, ExternalLink, FileText } from "lucide-react";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Markdown } from "./Markdown";
import { DOC_PARAM } from "./ReviewPanel";
import type { ProjectCard } from "~/lib/projects.shared";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CARD_PARAM = "card";

const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

const COLUMN_VARIANT: Record<string, "default" | "secondary" | "warning" | "destructive" | "outline"> = {
  "todo": "secondary",
  "in progress": "default",
  "blocked": "warning",
  "in review": "outline",
  "done": "secondary",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(updatedIso: string, now: Date): string {
  const diff = now.getTime() - new Date(updatedIso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Asset chip for links: entries
// ---------------------------------------------------------------------------

function LinkChip({
  href,
  onOpenDoc,
}: {
  href: string;
  onOpenDoc: (doc: string) => void;
}) {
  const filename = href.split("/").pop() ?? href;
  return (
    <button
      type="button"
      onClick={() => onOpenDoc(href)}
      className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted cursor-pointer"
      aria-label={`Open in review panel: ${filename}`}
      data-testid={`card-detail-link-chip`}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="label-mono truncate max-w-[200px]">{filename}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inner content (shared between mobile sheet and desktop dialog)
// ---------------------------------------------------------------------------

function CardDetailContent({
  card,
  now,
  onClose,
  onOpenDoc,
}: {
  card: ProjectCard;
  now: Date;
  onClose: () => void;
  onOpenDoc: (doc: string) => void;
}) {
  const diffMs = now.getTime() - new Date(card.updated).getTime();
  const isStale = diffMs > STALE_THRESHOLD_MS;
  const relLabel = relativeTime(card.updated, now);
  const dateLabel = formatDate(card.updated);
  const colVariant = COLUMN_VARIANT[card.column] ?? "secondary";

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-start gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0 flex-1">
          <h2
            data-testid="card-detail-title"
            className="font-display text-lg font-black uppercase tracking-tight text-foreground leading-tight"
          >
            {card.title}
          </h2>
          {/* Meta row */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Avatar name={card.agent} className="h-6 w-6 text-[10px]" />
            <span className="text-sm text-muted-foreground">{card.agent}</span>
            <Badge variant={colVariant} className="text-xs">
              {card.column}
            </Badge>
            <span
              className={cn(
                "label-mono text-[10px]",
                isStale ? "text-accent font-semibold" : "text-muted-foreground"
              )}
              title={card.updated}
              data-testid="card-detail-updated"
            >
              {relLabel} &middot; {dateLabel}
            </span>
            {card.ticket ? (
              <a
                href={card.ticket}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open ticket"
                data-testid="card-detail-ticket"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Ticket
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card detail"
          data-testid="card-detail-close"
          className="flex size-[44px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* links: asset-chip row */}
        {card.links && card.links.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-2" data-testid="card-detail-links">
            {card.links.map((link) => (
              <LinkChip key={link} href={link} onOpenDoc={onOpenDoc} />
            ))}
          </div>
        ) : null}

        {/* Card body via Markdown */}
        {card.body ? (
          <div className="prose-mc text-sm" data-testid="card-detail-body">
            <Markdown onOpenDoc={onOpenDoc}>
              {card.body}
            </Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// CardDetail - the exported component
// ---------------------------------------------------------------------------

/**
 * CardDetail reads ?card= and ?doc= from URL search params.
 *
 * ?card= / ?doc= interaction rule:
 *   - If ?doc= is set, doc panel wins; detail stays closed (return null).
 *   - If ?card= is set and ?doc= is NOT set, detail renders.
 *   - Opening a doc from the detail sets ?doc= and clears ?card=.
 *
 * Caller must provide the full cards array and the server-side now string.
 */
export function CardDetail({
  cards,
  now,
}: {
  cards: ProjectCard[];
  now: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const cardParam = searchParams.get(CARD_PARAM);
  const docParam = searchParams.get(DOC_PARAM);

  // doc param wins - detail stays closed.
  // One comment documents the both-set case per plan.
  if (docParam) return null;
  if (!cardParam) return null;

  const card = cards.find((c) => c.id === cardParam);

  function handleClose() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(CARD_PARAM);
      return next;
    });
  }

  // Opening a doc: set ?doc= and RETAIN ?card= (Atlas fold) - the doc-wins
  // precedence above hides the detail while the panel is open; closing the
  // panel restores it.
  function handleOpenDoc(doc: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(DOC_PARAM, doc);
      return next;
    });
  }

  if (!card) return null;

  const nowDate = new Date(now);

  return (
    <>
      {/* Mobile: full-screen sheet (<md) */}
      <div
        className="fixed inset-0 z-40 flex flex-col bg-background md:hidden"
        data-testid="card-detail-sheet"
      >
        <CardDetailContent
          card={card}
          now={nowDate}
          onClose={handleClose}
          onOpenDoc={handleOpenDoc}
        />
      </div>

      {/* Desktop: centred modal dialog over the board (md+) */}
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 hidden bg-background/60 backdrop-blur-sm md:block"
        onClick={handleClose}
        aria-hidden="true"
      />
      {/* Dialog */}
      <div
        className="fixed left-1/2 top-1/2 z-50 hidden w-full max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-xl md:flex"
        style={{ maxHeight: "80vh" }}
        data-testid="card-detail-dialog"
      >
        <CardDetailContent
          card={card}
          now={nowDate}
          onClose={handleClose}
          onOpenDoc={handleOpenDoc}
        />
      </div>
    </>
  );
}
