/**
 * DayDivider.tsx - Centered day-boundary divider for the thread timeline.
 *
 * Renders a horizontal rule with a centered label ("Today" / "Yesterday" /
 * "Thu 4 Jun") between messages that cross a London-local calendar day. The
 * label is metadata-styled in the Inkie label register: Space Grotesk
 * (font-mono), uppercase, muted, tiny.
 *
 * Pure presentational - the label string is computed upstream (time.ts
 * formatDayDivider) and passed in. No .server imports.
 * ASCII only - no em-dashes.
 */
interface DayDividerProps {
  /** Pre-formatted divider label (e.g. "Today", "Yesterday", "Thu 4 Jun"). */
  label: string;
}

/**
 * A centered day-divider row: a muted hairline either side of a tiny label.
 */
export function DayDivider({ label }: DayDividerProps) {
  return (
    <div
      className="my-4 flex items-center gap-3"
      role="separator"
      aria-label={label}
    >
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
