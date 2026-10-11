/**
 * splitBlocks: Split an inbox file into individual block strings.
 *
 * Grammar: each block starts at a line that PARSES as a header (see
 * isBlockHeaderLine) and runs up to the line before the next such line (or EOF
 * for the last block). Block boundaries are determined by header position ONLY,
 * never by scanning for a "---" line.
 *
 * A bare "---" line is the writer's trailing block separator, but it is NOT a
 * reliable boundary: a message body may legitimately contain a standalone "---"
 * line (a common visual-divider habit). Boundary detection on "---" silently
 * dropped everything after such a body line. Each
 * returned block string therefore carries everything up to the next header,
 * including any trailing "---" separator the writer appended AND any body-internal
 * "---" line. Stripping the genuine trailing separator is _parseBlock's job.
 */
import { HEADER_RE } from "./header.js";

/**
 * Does this line OPEN a block?
 *
 * Only a line that actually PARSES as a header may bound a block. A "## " line
 * that fails the grammar is body content - a markdown heading someone typed in
 * a message, or a blanked header left by a lossy re-serialise - and protocol
 * section 4 says so in as many words: "A line beginning with `## ` that does
 * not match the header grammar in section 5 does NOT begin a block."
 *
 * Testing only the "## " prefix, as this did until a later fix, ended the
 * preceding block at the first markdown heading its author typed and dropped
 * everything from there to the next real header out of the rendered message,
 * with no error and no visible gap. The bytes stayed on disk, so it was loss on
 * display only, but every read lost it again. Corpus cases body-markdown-heading
 * and pseudo-header-between-blocks pin it; the Python CLI in packages/base had
 * the same defect from the same cause and was fixed upstream first.
 *
 * HEADER_RE and not parseHeader, deliberately. parseHeader additionally rejects
 * a timestamp Date.parse cannot read, which is stricter than the protocol (a
 * timestamp is any run of non-whitespace and only SHOULD be ISO 8601 - sections
 * 5 and 9.1, corpus case unparseable-timestamp-still-a-block). Bounding on
 * parseHeader would make such a block stop being a block at all, and a first or
 * only block that stops being a block vanishes from the render entirely: a
 * strictly worse loss than the one being fixed here.
 *
 * What this does NOT close, both by design:
 *   - a WELL-FORMED header quoted inside a body (a code fence, an example).
 *     It parses, so it still bounds a block and still misattributes the prose
 *     after it. That is a different defect - misattribution, not loss, and no
 *     bytes go missing - and closing it needs a write-time change, not a
 *     reader-side guess about what is quoted.
 *   - an INDENTED well-formed header. Stripping the leading whitespace below
 *     keeps it a boundary, as it has always been; protocol section 4 anchors a
 *     block at column 0, and that departure is recorded against this
 *     implementation as corpus case indented-pseudo-header rather than quietly
 *     folded into this change.
 *
 * LEADING whitespace only, never a full trim(), and the two differ by a whole
 * class of message. HEADER_RE requires `subject:\s+` ahead of the subject
 * capture, so the space after that label is grammar, not padding, and a header
 * whose subject is EMPTY matches only by way of it: serializeHeader
 * interpolates the subject straight after "subject: ", so such a line ends in
 * that space with nothing following. A full trim() takes it off along with the
 * indentation, the line stops matching HEADER_RE, and the message stops opening
 * a block - it merges into the one above it, attributed to that block's sender,
 * with no error and nothing missing from disk. Empty subjects are ordinary
 * traffic here, not a corner case; every message written without one
 * serialises to exactly that shape. Stripping only what precedes the "##"
 * normalises the indentation this has always tolerated and leaves the rest of
 * the line as the writer emitted it.
 */
export function isBlockHeaderLine(line: string): boolean {
  return HEADER_RE.test(line.replace(/^\s+/, ""));
}

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
    if (isBlockHeaderLine(lines[i]!)) headerIdxs.push(i);
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
