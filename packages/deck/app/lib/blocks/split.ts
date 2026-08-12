/**
 * splitBlocks: Split an inbox file into individual block strings.
 *
 * Grammar: each block starts at a line beginning with "## " and runs up to the
 * line before the next "## " header (or EOF for the last block). Block boundaries
 * are determined by header position ONLY, never by scanning for a "---" line.
 *
 * A bare "---" line is the writer's trailing block separator, but it is NOT a
 * reliable boundary: a message body may legitimately contain a standalone "---"
 * line (a common visual-divider habit). Boundary detection on "---" silently
 * dropped everything after such a body line (hit Alex twice, 1 + 15 Jul). Each
 * returned block string therefore carries everything up to the next header,
 * including any trailing "---" separator the writer appended AND any body-internal
 * "---" line. Stripping the genuine trailing separator is _parseBlock's job.
 */

/**
 * Split raw inbox file content into block strings.
 * Each returned string is one complete block (header + meta + body + separator),
 * ending at its last non-blank line. Blocks with no content are filtered out.
 */
export function splitBlocks(raw: string): string[] {
  const lines = raw.split("\n");

  // Collect the line index of every block header.
  const headerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("## ")) headerIdxs.push(i);
  }

  const blocks: string[] = [];
  for (let h = 0; h < headerIdxs.length; h++) {
    const start = headerIdxs[h]!;
    const end = h + 1 < headerIdxs.length ? headerIdxs[h + 1]! : lines.length;
    let region = lines.slice(start, end);

    // Trim trailing blank lines: the file's final newline, and any blank lines
    // between a block's trailing "---" separator and the next header. The block
    // string ends at its last non-blank line - the "---" separator for a
    // terminated block, or the final body line for an unterminated one.
    while (region.length > 0 && region[region.length - 1]!.trim() === "") {
      region = region.slice(0, -1);
    }

    const blockStr = region.join("\n");
    if (blockStr.trim()) blocks.push(blockStr);
  }

  return blocks;
}
