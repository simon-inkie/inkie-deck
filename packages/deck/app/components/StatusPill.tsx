/**
 * StatusPill.tsx - the ONE rendering of an agent activity status.
 *
 * Extracted from ActivityPanel.tsx when the left-hand Sidebar grew the same
 * pill. Two renderings of the same concept in two files is how
 * "working" ends up primary-tinted in one column and muted in the other, so the
 * tint + glyph table lives here and both surfaces import it.
 *
 * THREE RULES THIS FILE HOLDS:
 *
 *   1. NEVER COLOUR ALONE. Every pill carries a glyph as well as a tint
 *      (WCAG 1.4.1, the same not-colour-alone rule WorkStrip's stale clock
 *      follows). In `compact` mode the glyph is the whole pill, so the status
 *      name travels as an accessible name, never as colour only.
 *   2. `unknown` IS NOT A VERDICT. Dashed outline, question glyph, none of the
 *      accent colours a real status uses. Callers that cannot show the evidence
 *      behind a pill (the Sidebar) drop `unknown` entirely rather than render a
 *      shrug next to an agent's name.
 *   3. A PILL IS A CLAIM ABOUT NOW. When the engine is offline the panel still
 *      shows the last state it saw, so `muted` strips the verdict tint off the
 *      pill and says "last known" in its tooltip: the glyph and the label stay
 *      legible as history, the confident colour does not.
 *
 * Presentational only, no .server imports (types come from
 * activity.shared).
 * ASCII only - no em-dashes.
 */
import {
  Activity as ActivityGlyph,
  Check,
  CircleQuestionMark,
  Hand,
  Server,
  TriangleAlert,
  Users,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { statusLabel, type ActivityStatus } from "~/lib/activity.shared";

type Glyph = typeof ActivityGlyph;

/**
 * Tint + glyph per status. `unknown` is the odd one out on purpose: a dashed
 * border and muted text, in none of the accent colours a real verdict uses.
 */
export const STATUS_STYLE: Record<ActivityStatus, { className: string; Icon: Glyph }> = {
  working: {
    className: "border-transparent bg-primary text-primary-foreground",
    Icon: ActivityGlyph,
  },
  stuck: {
    className: "border-transparent bg-destructive/15 text-destructive",
    Icon: TriangleAlert,
  },
  "needs-you": {
    className: "border-transparent bg-accent/15 text-accent",
    Icon: Hand,
  },
  "waiting-on-teammate": {
    className: "border-border bg-muted text-muted-foreground",
    Icon: Users,
  },
  "waiting-on-machine": {
    className: "border-border bg-muted text-muted-foreground",
    Icon: Server,
  },
  "done-for-now": {
    className: "border-transparent bg-primary/15 text-primary",
    Icon: Check,
  },
  unknown: {
    className: "border-dashed border-border bg-transparent text-muted-foreground",
    Icon: CircleQuestionMark,
  },
};

/** The no-verdict-tint treatment: shared by `unknown` and by every muted pill. */
const NO_VERDICT_CLASS = STATUS_STYLE.unknown.className;

export interface StatusPillProps {
  status: ActivityStatus;
  /**
   * data-testid for this pill. Each surface names its own (the panel's
   * `activity-status-<agent>`, the sidebar's `sidebar-status-<agent>`) so a
   * test can say WHICH rendering it is asserting on.
   */
  testId: string;
  /**
   * Glyph only, no text label - for the sidebar's tight column. The status
   * name becomes the accessible name instead of disappearing.
   */
  compact?: boolean;
  /**
   * Last-known rather than current: keeps the glyph and the label, drops the
   * verdict tint. Used when the sweep is offline and the panel is showing the
   * final state it wrote.
   */
  muted?: boolean;
}

export function StatusPill({ status, testId, compact = false, muted = false }: StatusPillProps) {
  const { className, Icon } = STATUS_STYLE[status];
  const label = statusLabel(status);
  return (
    <span
      data-testid={testId}
      data-status={status}
      data-muted={muted ? "true" : undefined}
      // role+aria-label rather than a bare title: a compact pill has no text
      // node at all, so the tooltip is not an accessible name on its own.
      role={compact ? "img" : undefined}
      aria-label={compact ? label : undefined}
      title={muted ? `last known status: ${status} (engine offline)` : `status: ${status}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border text-[11px] font-medium",
        compact ? "px-1 py-0.5" : "gap-1 px-2 py-0.5",
        muted ? NO_VERDICT_CLASS : className
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {compact ? null : label}
    </span>
  );
}
