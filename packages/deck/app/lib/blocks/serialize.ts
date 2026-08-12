/**
 * serializeBlock: Convert a MessageBlock back to the original raw string.
 *
 * Round-trip fidelity contract:
 *   serializeBlock(parseBlock(rawBlock)) === rawBlock (byte-for-byte)
 *
 * Implementation: re-emit from rawMeta verbatim (NOT from zod-serialized card data).
 * This preserves lean, blocking, original quoting, key ordering, and spacing.
 * Ref: RESEARCH.md Round-trip fidelity strategy, T-01-04.
 *
 * Spacing note: serialize normalises to double-newline separators between sections.
 * The byte-exact round-trip contract therefore holds only when the input was produced
 * by the parser (which stores rawMeta verbatim). Feeding a handcrafted MessageBlock
 * with different separators will produce normalised output, not a byte-identical copy.
 * The test contract is parse->serialize->parse stable (semantic), not arbitrary-string
 * byte-exact.
 *
 * Serialized format:
 *   <header line>
 *   <rawMeta (verbatim)>       <- only included when rawMeta is non-empty
 *                              <- blank line separator between meta/header and body
 *   <body>
 *
 *   ---
 */
import type { MessageBlock } from "./model.js";
import { serializeHeader } from "./header.js";

/**
 * Serialize a MessageBlock back to its original raw string.
 * Preserves unknown fields (lean, blocking, etc.) via rawMeta verbatim re-emission.
 */
export function serializeBlock(block: MessageBlock): string {
  const headerLine = serializeHeader(block.header);
  const { rawMeta, body } = block;

  if (rawMeta) {
    // Has metadata region: header + "\n" + rawMeta + "\n\n" + body + "\n\n---"
    return `${headerLine}\n${rawMeta}\n\n${body}\n\n---`;
  } else {
    // No metadata region: header + "\n\n" + body + "\n\n---"
    return `${headerLine}\n\n${body}\n\n---`;
  }
}
