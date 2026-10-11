/**
 * parseHeader / serializeHeader for inbox message block headers.
 *
 * Grammar (ASCII-normalised, per spec section 2.2):
 *   ## <ISO-8601-timestamp> - from: <name> - status: <sent|read|working> - subject: <subject>
 *
 * Key-anchored regex (NOT a naive " - " split) so hyphens in from-names and subjects
 * do not cause mis-parsing. Ref: RESEARCH.md Pitfall 2, T-01-06.
 *
 * On header parse failure the caller should treat the block as a plain bubble, never throw.
 */
import type { BlockHeader } from "./model.js";

/**
 * Key-anchored regex for the block header line.
 * - ts: the ISO-8601 timestamp (non-whitespace)
 * - from: non-greedy, up to the " - status:" anchor
 * - status: literal "sent", "read", or "working"; the whole
 *   "status: <...> -" segment is OPTIONAL on READ - headers that drop it
 *   (e.g. "## <ts> - from: <name> - subject: <subject>") still parse, with
 *   status defaulting to "read" in parseHeader. A status-less header that
 *   failed to match previously fell back to timestamp:"" and blanked the
 *   timestamp in the UI (same failure family as the dash-slip below).
 * - subject: greedy to end of line (allows hyphens in subjects)
 *
 * Field delimiter accepts an ASCII hyphen OR an em-dash (U+2014) OR an
 * en-dash (U+2013): agents repeatedly slip em-dashes into hand-written
 * headers despite the no-em-dash rule, and a header that fails to parse here
 * leaves an empty timestamp that took down the whole queue loader.
 * Tolerating the dash variants on READ keeps such cards
 * fully functional; serializeHeader still emits ASCII hyphens, so any
 * writeback self-heals the file back to the canonical grammar. The class uses
 * \u escapes (not literal glyphs) so this source stays clean for check:dashes.
 *
 * Source: RESEARCH.md section B, derived from spec section 2.2 ASCII-normalised grammar.
 */
// The `from` capture is a TEMPERED non-greedy token: the negative lookahead
// forbids it from consuming across a " - status:" boundary. Without it, an
// INVALID status value (e.g. "pondering") makes the optional status alternation
// fail, the group is skipped, and the plain non-greedy ".+?" backtracks to
// swallow the literal "status: pondering" into `from` - the header then parses
// ok:true with junk in `from` instead of failing outright and triggering the
// sentinel fallback. Tempering the token means "- status: <invalid>"
// can never be absorbed, so an invalid status value fails the whole match. A
// valid status (sent|read|working) still stops `from` at the same boundary and
// is captured by the optional group; a status-omitted header ("- subject:") is
// unaffected (no "- status:" ahead, so the lookahead never bites).
// Exported so callers that need the exact char range of a captured group (e.g.
// the byte-patch flip in inbox.server.ts, which must locate the "status" value unambiguously
// rather than re-searching the line with a second loose pattern) can derive
// match indices from THIS anchored grammar instead of duplicating it.
export const HEADER_RE =
  /^##\s+(?<ts>\S+)\s+[-\u2014\u2013]\s+from:\s+(?<from>(?:(?!\s+[-\u2014\u2013]\s+status:\s).)+?)\s+[-\u2014\u2013]\s+(?:status:\s+(?<status>sent|read|working)\s+[-\u2014\u2013]\s+)?subject:\s+(?<subject>.*)$/;

export type ParseHeaderResult =
  | { ok: true; header: BlockHeader }
  | { ok: false };

/**
 * Parse a single header line into a BlockHeader.
 * Returns { ok: false } if the line does not match the grammar - caller treats as plain bubble.
 */
export function parseHeader(line: string): ParseHeaderResult {
  const m = HEADER_RE.exec(line);
  if (!m?.groups) return { ok: false };

  const { ts, from, status, subject } = m.groups as Record<string, string>;

  // Validate timestamp: must be a valid ISO-8601-ish date
  // Use Date.parse as a reasonable check (it's lenient but catches obvious non-dates)
  if (isNaN(Date.parse(ts ?? ""))) return { ok: false };

  return {
    ok: true,
    header: {
      timestamp: ts ?? "",
      from: from ?? "",
      // status: is an optional segment on READ. When a header drops it, the
      // named group is undefined; default to "read" - consistent with the
      // parse-fail-defaults-read rationale (an absent status is not a "sent"
      // claim). serializeHeader still emits the canonical full grammar, so any
      // writeback self-heals the line.
      status: (status as "sent" | "read" | "working" | undefined) ?? "read",
      subject: subject ?? "",
    },
  };
}

/**
 * Serialize a BlockHeader back to a header line string.
 * Inverse of parseHeader; must produce valid HEADER_RE-matching output.
 */
export function serializeHeader(header: BlockHeader): string {
  // ROUND-TRIP GUARANTEE. When parseHeader failed, parse.ts hands us the original
  // line on rawHeader and we emit it verbatim.
  //
  // Without this the docstring above was false: the parse fallback substitutes an
  // empty timestamp/from/subject, and interpolating those emits
  // "##  - from:  - status: read - subject: ", which does NOT match HEADER_RE. So
  // reading a file and writing it back PERMANENTLY destroyed the header, and the
  // damage compounded with every read. Many header lines were
  // produced this way.
  //
  // Fixing it here rather than by making this throw: a throw pushes the decision
  // onto every caller and one of them gets it wrong quietly. Fixing it by deleting
  // the parse fallback is also wrong - that fallback exists for the
  // phantom-unread dots.
  if (header.rawHeader !== undefined) return header.rawHeader;
  return `## ${header.timestamp} - from: ${header.from} - status: ${header.status} - subject: ${header.subject}`;
}
