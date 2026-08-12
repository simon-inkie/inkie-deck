/**
 * MorningBrief.tsx - Daily morning brief panel on the home screen (TASK-442).
 *
 * Displays the most recent morning brief at the top of the home route,
 * between the header block and the needs-you sections.
 *
 * Collapse/expand:
 *   - Initial state: expanded when brief is today; collapsed when yesterday.
 *     Computed server-side (isToday prop) to avoid SSR hydration mismatch.
 *   - localStorage key mc-brief-seen-<date>: if seen, collapses on mount.
 *     Marked seen on first expanded render and on user collapse.
 *   - One-frame flash (expanded -> collapsed) on repeat same-day visits is
 *     accepted for v1; reading localStorage during render breaks SSR.
 *
 * ?doc= wiring: onOpenDoc is threaded in from home.tsx so links inside the
 * brief open in the ReviewPanel (same pattern as threads.$agent.tsx + projects).
 *
 * No .server imports - FND-02. ASCII only - no em-dashes - FND-05.
 */
import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "./Markdown";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MorningBriefProps {
  /** ISO date string YYYY-MM-DD from the brief filename. */
  date: string;
  /** Raw markdown content. */
  markdown: string;
  /**
   * Pass true when date === today's date (computed server-side).
   * Drives the SSR-deterministic initial expanded/collapsed state.
   */
  isToday: boolean;
  /**
   * Callback: called when user clicks a review-openable link inside the brief.
   * Wires into the ReviewPanel via home.tsx's handleOpenDoc.
   */
  onOpenDoc?: (doc: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localStorageKey(date: string): string {
  return `mc-brief-seen-${date}`;
}

function formatBriefDate(dateStr: string): string {
  // Parse YYYY-MM-DD and format as e.g. "7 June 2026" (en-GB).
  // Date string is UTC midnight; parse as UTC to avoid day-off issues.
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MorningBrief({
  date,
  markdown,
  isToday,
  onOpenDoc,
}: MorningBriefProps) {
  // SSR-deterministic initial state: expanded for today, collapsed for yesterday.
  const [expanded, setExpanded] = useState(isToday);
  const [markedSeen, setMarkedSeen] = useState(false);

  // Mount effect: if this brief was already seen, collapse.
  useEffect(() => {
    try {
      const seen = localStorage.getItem(localStorageKey(date));
      if (seen) {
        setExpanded(false);
      }
    } catch {
      // localStorage unavailable (SSR, private mode, etc) - ignore.
    }
  }, [date]);

  // Mark seen when expanded on mount (first expanded render).
  useEffect(() => {
    if (expanded && !markedSeen) {
      try {
        localStorage.setItem(localStorageKey(date), "1");
        setMarkedSeen(true);
      } catch {
        // ignore
      }
    }
  }, [expanded, markedSeen, date]);

  function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    // Mark seen when user collapses (belt-and-braces - already marked on first expand).
    if (!next) {
      try {
        localStorage.setItem(localStorageKey(date), "1");
      } catch {
        // ignore
      }
    }
  }

  const formattedDate = formatBriefDate(date);

  return (
    <div
      data-testid="morning-brief"
      className="mb-6 rounded-lg border border-border bg-card shadow-sm"
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="label-mono text-xs uppercase tracking-widest text-muted-foreground">
            Morning brief
          </span>
          <span className="label-mono text-xs text-muted-foreground">
            {formattedDate}
          </span>
        </div>
        <button
          type="button"
          data-testid="morning-brief-toggle"
          onClick={handleToggle}
          aria-label={expanded ? "Collapse morning brief" : "Expand morning brief"}
          aria-expanded={expanded}
          className={cn(
            "flex size-[44px] shrink-0 items-center justify-center rounded-md",
            "text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          )}
        >
          {expanded ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Collapsible body */}
      {expanded && (
        <div
          data-testid="morning-brief-body"
          className="border-t border-border px-4 py-4"
        >
          <div className="prose-mc text-sm">
            <Markdown onOpenDoc={onOpenDoc}>
              {markdown}
            </Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
