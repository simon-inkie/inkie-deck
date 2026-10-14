/**
 * ProjectCard.tsx - A single card on the projects kanban board.
 *
 * Displays:
 *   - Title (font-display, line-clamp-2)
 *   - Avatar for the agent (deterministic tint + initials)
 *   - Optional ticket external-link icon (link-out only, no mirroring)
 *   - Relative staleness label; accent-tinted when older than 3 days
 *
 * Move affordances (both post the same move intent):
 *   1. HTML5 native drag (desktop) - the card is draggable; the column handles
 *      the drop. This is a lightweight enhancement; the column drop handler
 *      drives the actual fetcher.post.
 *   2. Column dropdown (DropdownMenu) - touch/mobile/a11y path; same action.
 *
 * Optimistic UI is driven by the fetcher passed in from ProjectBoard.
 *
 * Board face: summary line shown under the title (1-2 line clamp, muted).
 * Card is clickable to open the CardDetail via onCardOpen callback.
 *
 * ASCII only - no em-dashes.
 */
import { ExternalLink } from "lucide-react";
import { Avatar } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { ProjectCard as ProjectCardType } from "~/lib/projects.shared";
import { VALID_COLUMNS } from "~/lib/projects.shared";
import { cn } from "~/lib/utils";

// Three days in milliseconds.
const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** Format a relative time label: "Xm ago", "Xh ago", "Xd ago". */
function relativeTime(updatedIso: string, now: Date): string {
  const diff = now.getTime() - new Date(updatedIso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

interface ProjectCardProps {
  card: ProjectCardType;
  now: Date;
  /** Post a move intent via the board's shared fetcher. */
  onMove: (cardId: string, column: string) => void;
  /** Called when a drag starts (to record which card is being dragged). */
  onDragStart: (cardId: string) => void;
  /** Called when the card face is clicked to open the detail overlay. */
  onCardOpen?: (cardId: string) => void;
}

export function ProjectCard({ card, now, onMove, onDragStart, onCardOpen }: ProjectCardProps) {
  const diffMs = now.getTime() - new Date(card.updated).getTime();
  const isStale = diffMs > STALE_THRESHOLD_MS;
  const relLabel = relativeTime(card.updated, now);

  return (
    <div
      draggable
      onDragStart={() => onDragStart(card.id)}
      data-testid={`card-${card.id}`}
      className="group cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      {/* Title - clickable to open detail */}
      <button
        type="button"
        onClick={() => onCardOpen?.(card.id)}
        className="w-full text-left mb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-label={`Open card detail: ${card.title}`}
        data-testid={`card-open-${card.id}`}
      >
        <p className="font-display line-clamp-2 text-sm font-semibold leading-snug text-foreground group-hover:text-primary transition-colors">
          {card.title}
        </p>
        {/* Summary line: 1-2 line clamp, muted */}
        {card.summary ? (
          <p
            className="mt-0.5 line-clamp-2 text-xs text-muted-foreground leading-snug"
            data-testid={`card-summary-${card.id}`}
          >
            {card.summary}
          </p>
        ) : null}
      </button>

      {/* Footer row: avatar + ticket link + stale label + move dropdown */}
      <div className="flex items-center gap-2">
        <Avatar name={card.agent} className="h-6 w-6 text-[10px]" />

        <span
          data-testid={`card-agent-${card.id}`}
          className="sr-only"
        >
          {card.agent}
        </span>

        {card.assignee ? (
          <span
            data-testid={`card-assignee-${card.id}`}
            className="label-mono rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] text-foreground"
            title={`For ${card.assignee}`}
          >
            for {card.assignee}
          </span>
        ) : null}

        {card.ticket ? (
          <a
            href={card.ticket}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open ticket"
            data-testid={`card-ticket-${card.id}`}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}

        <span
          className={cn(
            "label-mono ml-auto text-[10px]",
            isStale ? "text-accent font-semibold" : "text-muted-foreground"
          )}
          data-testid={`card-updated-${card.id}`}
          title={card.updated}
        >
          {relLabel}
        </span>

        {/* Column move dropdown - touch/a11y path */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Move card"
              data-testid={`card-move-${card.id}`}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <circle cx="8" cy="3" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="8" cy="13" r="1.5" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Move to column</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {VALID_COLUMNS.map((col) => (
              <DropdownMenuItem
                key={col}
                disabled={col === card.column}
                onSelect={() => onMove(card.id, col)}
                data-testid={`move-to-${col.replace(/\s/g, "-")}-${card.id}`}
              >
                <span
                  className={cn(
                    col === card.column && "font-semibold text-foreground"
                  )}
                >
                  {col}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
