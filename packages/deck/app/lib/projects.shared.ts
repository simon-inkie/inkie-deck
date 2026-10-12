/**
 * projects.shared.ts - Shared constants and types for the Projects kanban board.
 *
 * This module is safe for both server and client bundles (no fs/env imports).
 * projects.server.ts imports from here; ProjectBoard and ProjectCard import from here.
 *
 * Keeping these values outside projects.server.ts avoids importing a .server module
 * into client components (the .server suffix keeps fs out of the bundle,
 * but value imports from .server modules can still pull node builtins in some bundlers).
 *
 * ASCII only - no em-dashes.
 */

export const VALID_COLUMNS = [
  "todo",
  "in progress",
  "blocked",
  "in review",
  "done",
] as const;

export type Column = (typeof VALID_COLUMNS)[number];

/** Serialisable card object returned by listCards (loader-friendly). */
export interface ProjectCard {
  /** The filename (e.g. "task-426.md") - stable card id. */
  id: string;
  title: string;
  agent: string;
  column: Column;
  /** Optional Linear / external ticket URL. */
  ticket?: string;
  /**
   * ADDITIVE: the human user this card is for / waiting
   * on (the instance user id). Distinct from agent (the working lane owner).
   */
  assignee?: string;
  /**
   * ADDITIVE: normalised ticket identifier (e.g. "PROJ-123") derived
   * from the ticket: frontmatter field at read time. File value is untouched.
   * Absent when ticket: is missing or the value does not normalise.
   */
  ticketId?: string;
  /** ISO-8601 string. */
  updated: string;
  /**
   * ADDITIVE: first body paragraph, truncated to ~140 chars.
   * Empty string when the card has no body. Derived; not stored.
   */
  summary: string;
  /**
   * ADDITIVE: full body text (everything after the frontmatter fence).
   * Empty string when the card has no body. Derived; not stored.
   */
  body: string;
  /**
   * ADDITIVE: optional links: frontmatter key - string list of
   * local artefact paths. Absent when the key is missing or non-list.
   * Tolerant reader: non-string entries are filtered out with a warn.
   */
  links?: string[];
  /**
   * ADDITIVE: optional blocked-on: frontmatter key - free string
   * describing what is blocking this card (e.g. "PROJ-123 merge", "the owner's API key").
   * Absent when the key is missing or non-string (tolerant reader: non-string warns + ignored).
   */
  blockedOn?: string;
}

// ---------------------------------------------------------------------------
// Mini-card derivation
// ---------------------------------------------------------------------------

/**
 * Compact view-model for the work panel rows (slide-out; previously
 * the thread work strip). Serialisable - built in a loader, passed down.
 */
export interface MiniCard {
  id: string;
  title: string;
  column: string;
  updatedAgeDisplay: string;
  isStale: boolean;
}

/** Cards untouched for longer than this read as stale in the panel. */
export const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** Coarse relative age for mini-card rows ("5m ago" / "3h ago" / "2d ago"). */
export function relativeTime(updatedIso: string, now: Date): string {
  const diff = now.getTime() - new Date(updatedIso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

/**
 * Derive an agent's live (non-done) mini-cards from the full card list.
 * Used by the shell loader to feed the work-panel trigger + slide-out.
 */
export function toMiniCards(
  cards: ProjectCard[],
  agent: string,
  now: Date
): MiniCard[] {
  return cards
    .filter((c) => c.agent === agent && c.column !== "done")
    .map((c) => ({
      id: c.id,
      title: c.title,
      column: c.column,
      updatedAgeDisplay: relativeTime(c.updated, now),
      isStale: now.getTime() - new Date(c.updated).getTime() > STALE_THRESHOLD_MS,
    }));
}
