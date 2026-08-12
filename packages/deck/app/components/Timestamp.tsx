/**
 * Timestamp.tsx - Per-message clock-time stamp (Slack/WhatsApp style).
 *
 * Shows the London-local 24h clock time (e.g. "15:30") as the primary visible
 * stamp; the relative phrasing ("3 days ago") is kept on the title tooltip so
 * it is still reachable on hover. The absolute UTC form remains available via
 * the machine-readable dateTime attribute.
 *
 * TASK-719 adds an opt-in dated variant (withDate) for the Cards tab, which has
 * no day dividers to carry the date. Default (unset) rendering is unchanged.
 *
 * No .server imports - receives plain string props only (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */
import { formatCardStamp, formatCardTooltip, formatClockTime, formatRelative } from "~/lib/time";

interface TimestampProps {
  /** ISO-8601 timestamp string (e.g. "2026-06-01T10:00:00Z") */
  iso: string;
  /** Optional reference instant (ISO string) for relative calculation. */
  now?: string;
  /**
   * Opt-in dated stamp (TASK-719). When set, the visible text becomes an
   * age-readable stamp ("2 hours ago" while fresh, "22 Jul, 14:40" once past
   * 48h) and the tooltip carries the full absolute timestamp.
   *
   * Only the Cards tab sets this, via the same postAction seam the cards
   * already use to tell the two surfaces apart. The thread view leaves it
   * unset, so message bubbles keep the bare clock time they group under their
   * own day dividers.
   */
  withDate?: boolean;
}

/**
 * Renders a dual timestamp: relative label with absolute tooltip.
 *
 * The `now` prop accepts an ISO string (not a Date) so it crosses the
 * loader serialization boundary cleanly (Pitfall 5 - never pass Date objects).
 * When omitted, formatRelative defaults to the current wall clock.
 */
export function Timestamp({ iso, now, withDate }: TimestampProps) {
  const at = now ? new Date(now) : undefined;
  const label = withDate ? formatCardStamp(iso, at) : formatClockTime(iso);
  const title = withDate ? formatCardTooltip(iso, at) : formatRelative(iso, at);

  return (
    <time
      dateTime={iso}
      title={title}
      className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
    >
      {label}
    </time>
  );
}
