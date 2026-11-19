/**
 * time.ts - Pure date/time formatting helpers.
 *
 * No fs, no IO, no side effects. All functions accept injected inputs for
 * deterministic, node-env Vitest testability.
 *
 * The returned strings cross the loader serialization boundary as plain strings.
 * No .server suffix needed (no fs), but these are called from loaders.
 *
 * ASCII only - no em-dashes (check:dashes gate).
 */
import { formatDistance } from "date-fns";

/**
 * Parse an ISO string into a valid Date, or null if unparseable.
 *
 * The block parser deliberately falls back to an empty timestamp ("") on any
 * header it cannot parse (it never throws - see blocks/parse.ts). Downstream
 * formatters must therefore tolerate "" and other malformed input: a single
 * bad block must NOT crash the whole thread render. This is the shared guard.
 *
 * @param iso - A candidate ISO-8601 timestamp string
 * @returns A valid Date, or null when iso is empty / unparseable
 */
function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Coalesce a reference instant to a valid Date, falling back to the wall clock.
 *
 * Components derive their reference instant as `now ? new Date(now) : undefined`
 * from a serialized string prop, so a garbage `now` arrives here as an Invalid
 * Date. Passed on unchecked that either throws (date-fns formatDistance raises
 * "Invalid time value") or poisons arithmetic with NaN - both the failure shape
 * the malformed-timestamp guard exists to prevent. ActionCard already
 * coalesces its own candidate for exactly this reason; this is the same guard
 * at the sink, so every caller of the exported helpers gets it.
 *
 * Sibling of safeDate: that guards the SUBJECT instant (and returns null so the
 * caller can emit ""), this guards the REFERENCE instant (where "" would be
 * wrong, since the subject is perfectly readable against the real clock).
 *
 * @param now - A candidate reference instant, possibly an Invalid Date
 * @returns now when valid, else the current wall clock
 */
function safeNow(now: Date): Date {
  return Number.isNaN(now.getTime()) ? new Date() : now;
}

/**
 * Resolve the server-side "now" instant from an optional MC_NOW-style value.
 *
 * Every loader derives its clock as `process.env["MC_NOW"] ? new Date(...) :
 * new Date()`. A garbage MC_NOW value used to produce an Invalid Date that
 * later threw "Invalid time value" inside toISOString/date-fns - killing the
 * shell loader and with it the whole app. This helper coalesces unparseable
 * input to the real wall clock so a bad env var can degrade timestamps but
 * never crash Deck.
 *
 * Pure: callers pass the env VALUE (loaders read process.env themselves,
 * preserving the .server seam and test injectability).
 *
 * @param candidate - The MC_NOW value (or undefined when unset)
 * @returns A valid Date: parsed candidate when valid, else current wall clock
 */
export function resolveNow(candidate: string | undefined): Date {
  if (candidate) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
    console.warn(`[time] MC_NOW value "${candidate}" is unparseable - falling back to wall clock`);
  }
  return new Date();
}

/**
 * Format an ISO timestamp as a fixed-width absolute date string in UTC.
 *
 * Returns a "yyyy-MM-dd HH:mm" string (UTC, ASCII only).
 * Safe to display across the serialization boundary as a plain string.
 *
 * Uses UTC to avoid timezone-dependent output on different host systems.
 *
 * @param iso - An ISO-8601 timestamp string (e.g. "2026-06-01T10:00:00Z")
 * @returns Formatted date string in UTC (e.g. "2026-06-01 10:00"), or "" if unparseable
 */
export function formatAbsolute(iso: string): string {
  const date = safeDate(iso);
  if (!date) return "";
  // Format in UTC to avoid host timezone producing different results
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format an ISO timestamp as a human-readable relative string.
 *
 * Returns a "N days ago" or "in N days" style string computed against
 * the injected now parameter. When now is omitted it defaults to new Date()
 * (current wall clock), but callers in tests MUST pass a fixed now for
 * deterministic assertions.
 *
 * Uses date-fns formatDistance with addSuffix to produce the relative string,
 * passing the injected now so no internal wall-clock read occurs.
 *
 * @param iso - An ISO-8601 timestamp string (e.g. "2026-06-01T10:00:00Z")
 * @param now - Reference point for the relative calculation (default: new Date())
 * @returns Relative string (e.g. "2 days ago", "in 3 hours")
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const date = safeDate(iso);
  if (!date) return "";
  return formatDistance(date, now, { addSuffix: true });
}

/**
 * Format a millisecond duration as a terse "Xh Ym" / "Ym" string, for the
 * top-bar escalation alert's "wedged Xh Ym" phrasing.
 *
 * Deliberately NOT formatRelative: that renders "about 2 hours ago" (a claim
 * anchored to a past instant, phrased for date-fns' coarse buckets), whereas
 * the escalation alert already holds a precise duration (now - statusSince)
 * and needs it as a plain elapsed-time span, not a fuzzy "about" sentence.
 * Minutes-only durations omit the hours segment ("12m", not "0h 12m").
 * Negative/NaN input (should not happen - callers only pass an already
 * threshold-cleared durationMs) degrades to "0m" rather than a "-5m" or
 * "NaNh NaNm" string.
 *
 * @param ms - Elapsed duration in milliseconds
 * @returns "2h 15m" | "12m"
 */
export function formatDurationHm(ms: number): string {
  const totalMinutes = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) : 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Display timezone for clock + day-grouping. Block timestamps are ISO UTC. */
const DISPLAY_TZ = "Europe/London";

/**
 * Format an ISO timestamp as a 24h clock time in Europe/London local.
 *
 * Block timestamps are stored as ISO UTC (e.g. "2026-06-04T14:30:00Z"); this
 * renders the wall-clock time a London viewer sees (BST = UTC+1 right now, so
 * 14:30Z displays as "15:30"). Pinning timeZone makes the output deterministic
 * regardless of the host system clock, so it is node-env Vitest testable.
 *
 * @param iso - An ISO-8601 timestamp string
 * @returns 24h "HH:mm" string in Europe/London (e.g. "15:30")
 */
export function formatClockTime(iso: string): string {
  const date = safeDate(iso);
  if (!date) return "";
  const out = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  // Some engines emit "24:mm" for midnight under hour12:false; normalise to 00.
  return out.startsWith("24:") ? `00:${out.slice(3)}` : out;
}

/**
 * Age (ms) at which a card stamp stops being relative and becomes absolute.
 *
 * 48h. Boundary is INCLUSIVE on the absolute side: an age of exactly 48h
 * renders "23 Jul, 14:40", not "2 days ago". Reason: date-fns coarsens to whole
 * days from 24h onward, so by 48h the relative phrasing has already lost the
 * precision the operator needs to judge whether a card is stale ("2 days ago"
 * reads the same for 48h and 60h). Making the switch inclusive keeps the two branches
 * disjoint with no ambiguous instant and is trivially pinnable in a test.
 */
const CARD_STAMP_ABSOLUTE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Assemble a Europe/London absolute stamp from Intl parts.
 *
 * Built from formatToParts rather than .format() so the separators are ours,
 * not the locale data's: the exact shape is pinned by tests and must not drift
 * with an ICU upgrade. Also normalises the "24:mm" midnight some engines emit
 * under hour12:false, matching formatClockTime.
 *
 * @param date - A valid Date
 * @param withYear - Include the year (tooltip form) or omit it (visible stamp)
 * @returns "22 Jul, 14:40" or "22 Jul 2026, 14:40"
 */
function londonStamp(date: Date, withYear: boolean): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TZ,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const head = withYear ? `${get("day")} ${get("month")} ${get("year")}` : `${get("day")} ${get("month")}`;
  return `${head}, ${hour}:${get("minute")}`;
}

/**
 * Card-tab stamp: relative while a card is fresh, absolute once it is stale.
 *
 * The Cards tab (unlike the thread view) is a flat list with no day dividers,
 * so a bare clock time gives no age signal at all: "05:05" could be this
 * morning or three weeks ago, and a dead card looks live.
 *
 * Under 48h old this returns the same relative phrasing the tooltip has always
 * used ("about 2 hours ago"), so the two never disagree. From 48h onward it
 * returns a London-local absolute stamp instead, because the relative form has
 * stopped resolving days apart by then.
 *
 * Timezone is pinned to DISPLAY_TZ exactly as formatClockTime does, so output
 * is deterministic under node-env Vitest regardless of the host clock or TZ.
 * Deliberately NOT formatAbsolute, which renders UTC in yyyy-MM-dd HH:mm (a
 * different contract, for machine-ish display).
 *
 * An Invalid Date `now` is treated as ABSENT and falls back to the wall clock,
 * matching what the `now: Date = new Date()` default parameter already does for
 * an omitted argument, so both entry paths behave the same. This is an explicit
 * decision, not inherited behaviour: NaN must NOT be allowed to select the
 * branch implicitly. Unguarded, `age` is NaN, `NaN < CARD_STAMP_ABSOLUTE_AFTER_MS`
 * is false, and the absolute branch (which never reads `now`) silently wins, so
 * a five-minute-old card would render "25 Jul, 19:40" instead of "5 minutes
 * ago". That is exactly the fresh-looks-stale confusion that the card stamp exists to kill,
 * and it fails with no error anywhere. Pinned by test.
 *
 * @param iso - An ISO-8601 timestamp string
 * @param now - Reference instant (default: new Date()); tests MUST inject one.
 *   An Invalid Date is coalesced to the wall clock (see safeNow).
 * @returns "about 2 hours ago" | "22 Jul, 14:40", or "" if unparseable
 */
export function formatCardStamp(iso: string, now: Date = new Date()): string {
  const date = safeDate(iso);
  if (!date) return "";
  // Coalesce BEFORE the arithmetic: a NaN age must never reach the comparison.
  const ref = safeNow(now);
  // Future timestamps (negative age) stay relative: "in 3 hours" is the useful
  // reading for a scheduled card, and it can never be "stale".
  const age = ref.getTime() - date.getTime();
  if (age < CARD_STAMP_ABSOLUTE_AFTER_MS) return formatRelative(iso, ref);
  return londonStamp(date, false);
}

/**
 * Full hover text for a card stamp: absolute London time plus the relative age.
 *
 * The visible stamp only ever shows one of the two (see formatCardStamp), so
 * the tooltip carries both, with the year that the visible form omits. This is
 * the "full timestamp on hover" half of the card timestamp display.
 *
 * @param iso - An ISO-8601 timestamp string
 * @param now - Reference instant (default: new Date()); tests MUST inject one.
 *   An Invalid Date is coalesced to the wall clock (see safeNow): unguarded it
 *   reaches date-fns and throws "Invalid time value", killing the page render.
 * @returns "22 Jul 2026, 14:40 (2 days ago)", or "" if unparseable
 */
export function formatCardTooltip(iso: string, now: Date = new Date()): string {
  const date = safeDate(iso);
  if (!date) return "";
  return `${londonStamp(date, true)} (${formatRelative(iso, safeNow(now))})`;
}

/**
 * Sortable Europe/London calendar-day key for an ISO timestamp.
 *
 * Returns "yyyy-MM-dd" for the London-local day, so a 23:30Z message (which is
 * 00:30 next day in BST) groups onto the correct day. Used for day-boundary
 * detection between consecutive messages.
 *
 * @param iso - An ISO-8601 timestamp string
 * @returns "yyyy-MM-dd" London-local day key (e.g. "2026-06-04"), or "" if unparseable
 */
export function londonDayKey(iso: string): string {
  const date = safeDate(iso);
  if (!date) return "";
  // en-CA yields yyyy-mm-dd, which is lexically sortable.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Human day-divider label for a message timestamp, relative to now.
 *
 * "Today" / "Yesterday" for the two most recent London-local days, otherwise a
 * short absolute date "EEE d MMM" (e.g. "Thu 4 Jun"). Compared on London-local
 * calendar days so a 23:30Z message lands under the right divider.
 *
 * Yesterday is derived from now minus 24h then keyed; across the twice-yearly
 * DST shift this can be off by the 1h transition window, which is immaterial
 * for a cosmetic divider.
 *
 * @param iso - An ISO-8601 timestamp string for the message
 * @param now - Reference instant (default: new Date()); callers pass the
 *   server-side now for determinism
 * @returns "Today" | "Yesterday" | "Thu 4 Jun"
 */
export function formatDayDivider(iso: string, now: Date = new Date()): string {
  const date = safeDate(iso);
  if (!date) return "";
  const dayKey = londonDayKey(iso);
  const todayKey = londonDayKey(now.toISOString());
  const yesterdayKey = londonDayKey(
    new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  );
  if (dayKey === todayKey) return "Today";
  if (dayKey === yesterdayKey) return "Yesterday";
  // Older: "Thu 4 Jun" (en-GB inserts a comma, which we strip to match spec).
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(date)
    .replace(",", "");
}
