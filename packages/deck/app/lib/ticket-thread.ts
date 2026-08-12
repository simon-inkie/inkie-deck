/**
 * ticket-thread.ts - Pure aggregation helper for the ticket-thread lens.
 *
 * aggregateTicketThread collects all message blocks tagged with a given ticket
 * id from a multi-agent entry list, sorted chronologically. Each result entry
 * carries the originating agent name so the lens can render origin tags.
 *
 * No IO, no fs, no env access, no .server imports (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */

import type { MessageBlock } from "./blocks/model.js";

/** An entry from one agent thread (agentName + parsed block). */
export interface AgentBlockEntry {
  agentName: string;
  block: MessageBlock;
}

/** A message in the aggregated ticket thread, with its home agent. */
export interface TicketThreadMessage {
  agentName: string;
  block: MessageBlock;
}

/**
 * Aggregate all blocks tagged with ticketId from the provided entries.
 *
 * Filters entries to those whose block.ticket matches ticketId (case-insensitive
 * comparison on already-normalised ids). Sorts chronologically by block header
 * timestamp (ascending). Returns an empty array when nothing matches.
 *
 * @param entries   - All agent block entries (agentName + parsed block).
 * @param ticketId  - The normalised ticket id to match (e.g. "TASK-445").
 * @returns Chronologically sorted array of ticket thread messages.
 */
export function aggregateTicketThread(
  entries: AgentBlockEntry[],
  ticketId: string
): TicketThreadMessage[] {
  const upper = ticketId.toUpperCase();
  const matched: TicketThreadMessage[] = [];

  for (const entry of entries) {
    if (
      entry.block.ticket !== undefined &&
      entry.block.ticket.toUpperCase() === upper
    ) {
      matched.push({ agentName: entry.agentName, block: entry.block });
    }
  }

  // Sort chronologically by timestamp (ascending).
  matched.sort((a, b) => {
    const ta = a.block.header.timestamp;
    const tb = b.block.header.timestamp;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return matched;
}
