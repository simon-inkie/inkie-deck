/**
 * WorkStrip.tsx - the agent's live cards as a vertical list (TASK-439,
 * reshaped TASK-454).
 *
 * TASK-454: the strip left its row under the thread header. It now renders
 * INSIDE the slide-out work panel (AppShell), opened from the top-bar
 * trigger left of the bell - Alex's "properties style column". Rows are
 * full-width: untruncated title, column Badge, age, stale clock glyph.
 *
 * ENTIRELY READ-ONLY: no moves, no ticks, no editing. The list is a
 * navigation aid; each row links to /projects?card=<id>.
 *
 * The list is absent when the agent has no live cards (the panel trigger
 * itself is also absent - AppShell gates on cards.length).
 *
 * Staleness is signalled by a Clock glyph + accent text (not colour alone -
 * WCAG 1.4.1, Atlas fold on the TASK-454 plan).
 *
 * 44px min targets throughout (touch-target compliance).
 *
 * No .server imports - FND-02. ASCII only - no em-dashes - FND-05.
 */
import { Link } from "react-router";
import { Clock } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "~/lib/utils";
import type { MiniCard } from "~/lib/projects.shared";

// Re-export so existing imports of the view-model keep one canonical name.
export type { MiniCard } from "~/lib/projects.shared";

// ---------------------------------------------------------------------------
// Column Badge variant map
// ---------------------------------------------------------------------------

const COLUMN_VARIANT: Record<string, "default" | "secondary" | "warning" | "destructive" | "outline"> = {
  "todo": "secondary",
  "in progress": "default",
  "blocked": "warning",
  "in review": "outline",
  "done": "secondary",
};

// ---------------------------------------------------------------------------
// Max cards listed before "+N more"
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * WorkStrip - the read-only vertical card list for the work panel.
 *
 * Props:
 *   cards: mini-card rows already filtered to (agent === thread agent) and
 *          (column !== done). Empty array -> list absent.
 *   onNavigate: called when any row is clicked (AppShell closes the panel).
 */
export function WorkStrip({
  cards,
  onNavigate,
}: {
  cards: MiniCard[];
  onNavigate?: () => void;
}) {
  if (cards.length === 0) return null;

  const visible = cards.slice(0, MAX_VISIBLE);
  const overflow = cards.length - visible.length;

  return (
    <div data-testid="work-strip" className="flex flex-col gap-1.5">
      {visible.map((card) => (
        <MiniCardRow key={card.id} card={card} onNavigate={onNavigate} />
      ))}
      {overflow > 0 ? (
        <Link
          to="/projects"
          data-testid="work-strip-overflow"
          onClick={onNavigate}
          className="inline-flex min-h-11 items-center rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          +{overflow} more
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiniCardRow
// ---------------------------------------------------------------------------

function MiniCardRow({
  card,
  onNavigate,
}: {
  card: MiniCard;
  onNavigate?: () => void;
}) {
  const colVariant = COLUMN_VARIANT[card.column] ?? "secondary";

  return (
    <Link
      to={`/projects?card=${encodeURIComponent(card.id)}`}
      data-testid={`work-strip-card-${card.id}`}
      onClick={onNavigate}
      className="flex min-h-11 flex-col justify-center gap-1 rounded-md border border-border bg-card px-3 py-2 hover:bg-muted transition-colors"
    >
      <p
        className={cn(
          "label-mono text-xs font-medium leading-snug",
          card.isStale ? "font-semibold text-accent" : "text-foreground"
        )}
      >
        {card.title}
      </p>
      <div className="flex items-center gap-1.5">
        <Badge variant={colVariant} className="text-[10px] px-1.5 py-0">
          {card.column}
        </Badge>
        <span
          className={cn(
            "label-mono text-[10px]",
            card.isStale ? "font-semibold text-accent" : "text-muted-foreground"
          )}
        >
          {card.updatedAgeDisplay}
        </span>
        {card.isStale ? (
          <Clock
            className="size-3 shrink-0 text-accent"
            aria-label={`Stale - last updated ${card.updatedAgeDisplay}`}
            data-testid="work-strip-stale"
          />
        ) : null}
      </div>
    </Link>
  );
}
