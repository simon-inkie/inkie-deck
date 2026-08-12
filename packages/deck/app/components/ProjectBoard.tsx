/**
 * ProjectBoard.tsx - Five-column kanban board for the Projects route.
 *
 * Columns: todo / in progress / blocked / in review / done (fixed, hard-coded).
 * Each column is a drag-drop target. Cards are rendered as ProjectCard.
 *
 * Move affordances:
 *   1. HTML5 native drag (desktop) - draggable cards, column onDrop -> post intent.
 *   2. DropdownMenu on each card (touch/a11y path) - same fetcher.post.
 *
 * Both affordances post the same "move" form data via a single shared useFetcher.
 * Optimistic UI: if the fetcher is submitting a move for a card, we render it
 * in the target column immediately.
 *
 * Mobile (<md): horizontally scrollable snap columns.
 *
 * No new dependencies - uses existing useFetcher from react-router.
 * ASCII only - no em-dashes (FND-05).
 */
import { useState } from "react";
import { useFetcher } from "react-router";
import { ProjectCard } from "./ProjectCard";
import type { ProjectCard as ProjectCardType, Column } from "~/lib/projects.shared";
import { VALID_COLUMNS } from "~/lib/projects.shared";
import { cn } from "~/lib/utils";

// Human-readable column labels (same as values for these columns).
const COLUMN_LABELS: Record<Column, string> = {
  "todo": "Todo",
  "in progress": "In Progress",
  "blocked": "Blocked",
  "in review": "In Review",
  "done": "Done",
};

interface ProjectBoardProps {
  cards: ProjectCardType[];
  /** ISO-8601 string from loader (MC_NOW-aware). */
  now: string;
  /** Called when a card face is clicked to open the detail overlay (TASK-439). */
  onCardOpen?: (cardId: string) => void;
}

export function ProjectBoard({ cards, now, onCardOpen }: ProjectBoardProps) {
  const fetcher = useFetcher();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Column | null>(null);
  const nowDate = new Date(now);

  // Compute the optimistic column for a card: if the fetcher is submitting a
  // move for this card, show the target column immediately.
  function getEffectiveColumn(card: ProjectCardType): Column {
    if (
      fetcher.state === "submitting" &&
      fetcher.formData?.get("intent") === "move" &&
      fetcher.formData?.get("cardId") === card.id
    ) {
      const targetCol = fetcher.formData?.get("column") as Column;
      if (targetCol && VALID_COLUMNS.includes(targetCol)) {
        return targetCol;
      }
    }
    return card.column;
  }

  function handleMove(cardId: string, column: string) {
    const formData = new FormData();
    formData.set("intent", "move");
    formData.set("cardId", cardId);
    formData.set("column", column);
    fetcher.submit(formData, { method: "POST", action: "/projects" });
  }

  function handleDragOver(e: React.DragEvent, col: Column) {
    e.preventDefault();
    setDragOverColumn(col);
  }

  function handleDrop(e: React.DragEvent, col: Column) {
    e.preventDefault();
    setDragOverColumn(null);
    if (draggingId) {
      handleMove(draggingId, col);
      setDraggingId(null);
    }
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverColumn(null);
  }

  // Group cards by their effective column (applies optimistic update).
  const byColumn: Record<Column, ProjectCardType[]> = {
    "todo": [],
    "in progress": [],
    "blocked": [],
    "in review": [],
    "done": [],
  };

  for (const card of cards) {
    const col = getEffectiveColumn(card);
    byColumn[col].push(card);
  }

  return (
    <div
      className="flex h-full gap-4 overflow-x-auto p-6 md:snap-x md:snap-mandatory"
      data-testid="project-board"
    >
      {VALID_COLUMNS.map((col) => {
        const colCards = byColumn[col];
        const isDragTarget = dragOverColumn === col;

        return (
          <div
            key={col}
            data-testid={`column-${col.replace(/\s/g, "-")}`}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-xl border border-border bg-muted/30 snap-start transition-colors",
              isDragTarget && "border-accent/50 bg-accent/5"
            )}
            onDragOver={(e) => handleDragOver(e, col)}
            onDragLeave={() => setDragOverColumn(null)}
            onDrop={(e) => handleDrop(e, col)}
          >
            {/* Column header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
              <span className="label-mono text-xs font-semibold uppercase tracking-wide text-foreground">
                {COLUMN_LABELS[col]}
              </span>
              <span
                className="label-mono rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                data-testid={`column-count-${col.replace(/\s/g, "-")}`}
              >
                {colCards.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {colCards.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-8">
                  <span className="text-xs text-muted-foreground/50">Empty</span>
                </div>
              ) : (
                colCards.map((card) => (
                  <ProjectCard
                    key={card.id}
                    card={card}
                    now={nowDate}
                    onMove={handleMove}
                    onDragStart={(id) => setDraggingId(id)}
                    onCardOpen={onCardOpen}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
