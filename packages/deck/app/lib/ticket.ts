/**
 * ticket.ts - Pure helpers for Linear ticket identifier normalisation.
 *
 * No IO, no fs, no env access, no .server imports (FND-02).
 * ASCII only - no em-dashes (FND-05).
 *
 * TICKET_BASE_URL: the Linear URL prefix for the example-org placeholder org.
 *   Change this single constant if the org slug ever moves.
 *
 * normaliseTicket(raw): accepts
 *   - bare identifier: "TASK-445" (case-insensitive) -> "TASK-445" (uppercased)
 *   - Linear URL: "https://linear.app/<org>/issue/<ID>[/slug][?query][#frag]"
 *     -> uppercased ID
 *   - anything else -> null (warn + absent; never throws)
 *
 * ticketUrl(id): builds the canonical Linear URL from a normalised id.
 */

/** Linear URL prefix for the example-org placeholder organisation. */
export const TICKET_BASE_URL = "https://linear.app/example-org/issue/";

/** Strict regex for a bare ticket identifier: one or more letters, hyphen, digits. */
const BARE_ID_RE = /^([A-Za-z]+-\d+)$/;

/**
 * Regex for a Linear issue URL.
 * Captures the ticket identifier from:
 *   https://linear.app/<org>/issue/<ID>[/optional-slug][?query][#frag]
 *
 * The captured group is the raw ID (case may vary).
 * The slug, query, and fragment are tolerated but ignored.
 */
const LINEAR_URL_RE =
  /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/;

/**
 * Normalise a raw ticket value to an uppercase identifier string, or null.
 *
 * Accepts:
 *   - Bare id (case-insensitive, e.g. "task-445" -> "TASK-445")
 *   - Linear URL (e.g. "https://linear.app/example-org/issue/TASK-445/slug" -> "TASK-445")
 *
 * Returns null for anything that does not match either form.
 * Warns to console.warn when the value is non-empty but unrecognised.
 * Never throws.
 */
export function normaliseTicket(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Try bare id first.
  const bareMatch = BARE_ID_RE.exec(trimmed);
  if (bareMatch) {
    return (bareMatch[1] as string).toUpperCase();
  }

  // Try Linear URL.
  const urlMatch = LINEAR_URL_RE.exec(trimmed);
  if (urlMatch) {
    return (urlMatch[1] as string).toUpperCase();
  }

  // Unrecognised: warn and return null.
  console.warn(
    `[ticket] unrecognised ticket value "${trimmed}" - field absent`
  );
  return null;
}

/**
 * Build the canonical Linear URL for a normalised ticket identifier.
 *
 * @param id - An uppercase normalised ticket id (e.g. "TASK-445").
 * @returns The Linear issue URL.
 */
export function ticketUrl(id: string): string {
  return `${TICKET_BASE_URL}${id}`;
}
