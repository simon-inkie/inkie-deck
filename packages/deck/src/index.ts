/**
 * inkie-deck entry point.
 *
 * Skeleton slice: no application features yet. What this file does establish
 * is the two structural facts the guards in this repository enforce:
 *
 *   - deck depends on inkie-agents-base through its published entry point
 *     (the import below is the legal edge the dependency-cruiser boundary
 *     check permits; a deep import into packages/base internals is not)
 *   - the hosted-capability seam is part of the public shape from day one
 */
import { HEADER_RE, parseBlocks } from "inkie-agents-base";

export {
  CAPABILITY_NAMES,
  resolveCapability,
  resolveCapabilities,
  withCapability,
  type AbsentCapability,
  type Capability,
  type CapabilityName,
  type ConfiguredCapability,
} from "./capabilities.ts";

/**
 * Placeholder consumer of the protocol package, proving the workspace edge
 * resolves. Counts the unread blocks in a raw thread file's text.
 */
export function countUnread(threadText: string): number {
  return parseBlocks(threadText).filter((block) => block.status === "sent").length;
}

/** Re-exported so a future UI layer never re-derives the header grammar. */
export { HEADER_RE };
