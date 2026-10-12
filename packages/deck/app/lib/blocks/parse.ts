/**
 * parseBlock: Orchestrate the five parsing stages for a single inbox message block.
 *
 * Stages:
 *   1. Split block lines
 *   2. parseHeader (key-anchored regex)
 *   3. extractMetaRegion (lines between header and first blank line)
 *   4. YAML.parse(region) - wrapped so YAML errors become plain bubbles
 *   5. CardSchema.safeParse - on failure, card:undefined
 *
 * parseBlock NEVER throws. Any failure at any stage yields card:undefined.
 * A plain message with no metadata region is the NORMAL case, not an error.
 */
import YAML from "yaml";
import type { MessageBlock, DecisionCard, ActionCard } from "./model.js";
import { parseHeader } from "./header.js";
import { CardSchema, ActionSchema, normalisePriority } from "./schema.js";
import { normaliseTicket } from "../ticket.js";

/**
 * Read a string meta value (dismiss-reason, done-note, supersede-note). These
 * are JSON.stringify'd on write so colons, quotes and newlines survive YAML;
 * YAML.parse (line 185) already unquotes the value, so rawObj[key] is the
 * fully-decoded string and we return it directly. A second JSON.parse here
 * would be redundant in the common case and would actively corrupt a note whose
 * own text is a JSON string literal (e.g. contains its own quote chars) by
 * stripping them. Returns undefined when absent/empty.
 */
function decodeJsonMetaString(
  rawObj: Record<string, unknown>,
  key: string
): string | undefined {
  const rawValue = rawObj[key];
  return typeof rawValue === "string" && rawValue.trim() !== ""
    ? rawValue
    : undefined;
}

/**
 * Read a plain (non-JSON) string timestamp meta value written by an apply*
 * function (dismissed, superseded). Returns the trimmed value or undefined.
 */
function readMetaTimestamp(
  rawObj: Record<string, unknown>,
  key: string
): string | undefined {
  const rawValue = rawObj[key];
  return typeof rawValue === "string" && rawValue.trim() !== ""
    ? rawValue.trim()
    : undefined;
}

/**
 * Parse a raw block string into a MessageBlock.
 * Returns a plain bubble (card:undefined) on any parsing failure.
 * NEVER throws.
 */
export function parseBlock(raw: string): MessageBlock {
  try {
    return _parseBlock(raw);
  } catch {
    // Absolute last-resort catch - should not be reached, but ensures the never-throw contract.
    // status "read" (not "sent"): an unparseable block must NOT generate a perpetual
    // unread signal. With "sent", the sidebar's hasUnread (from != user && status ==
    // "sent") lit a phantom magenta dot that markRead could never clear - the block
    // re-serializes to a header that fails parse again, so it falls back to unread
    // forever. A block we cannot even parse is
    // far likelier to be old/corrupt than a fresh message; default it read.
    return {
      header: { timestamp: "", from: "", status: "read", subject: "" },
      body: raw,
      card: undefined,
      rawMeta: "",
      rawBlock: raw,
    };
  }
}

function _parseBlock(raw: string): MessageBlock {
  if (!raw.trim()) {
    // status "read": an empty block is not a real unread message - see the
    // catch-fallback note above on the phantom-dot root cause.
    return {
      header: { timestamp: "", from: "", status: "read", subject: "" },
      body: "",
      card: undefined,
      rawMeta: "",
      rawBlock: raw,
    };
  }

  const lines = raw.split("\n");

  // Stage 1: Find the header line (first line starting with ##)
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("## ")) {
      headerIdx = i;
      break;
    }
  }

  // Stage 2: Parse the header
  const headerLine = headerIdx >= 0 ? (lines[headerIdx] ?? "") : "";
  const headerResult = parseHeader(headerLine);

  // Fall back to minimal header on parse failure (never throw).
  // status "read" (not "sent"): a header we cannot parse (e.g. blanked
  // timestamp/from from a lossy re-serialize) must not nag as unread forever -
  // this is the exact path that lit phantom unread dots.
  const header = headerResult.ok
    ? headerResult.header
    : {
        timestamp: "",
        from: "",
        status: "read" as const,
        subject: "",
        // Carry the ORIGINAL line so serializeHeader can round-trip it verbatim
        // instead of writing back a blanked header that no parser can read.
        rawHeader: headerLine,
      };

  // Stage 3: Extract the metadata region (lines between header and first blank line)
  // Lines start at headerIdx+1
  const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  let firstBlankIdx = -1;

  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i] === "") {
      firstBlankIdx = i;
      break;
    }
  }

  let rawMeta = "";
  let bodyStartIdx: number;

  if (firstBlankIdx === -1) {
    // No blank line found - everything after header is body, no metadata
    rawMeta = "";
    bodyStartIdx = startIdx;
  } else if (firstBlankIdx === startIdx) {
    // Blank line immediately after header - no metadata region
    rawMeta = "";
    bodyStartIdx = firstBlankIdx + 1;
  } else {
    // There IS a metadata region: lines[startIdx..firstBlankIdx-1]
    rawMeta = lines.slice(startIdx, firstBlankIdx).join("\n");
    bodyStartIdx = firstBlankIdx + 1;
  }

  // Stage 4 & 5: Parse the body (everything from bodyStartIdx to end).
  // Only strip a trailing "---" when it is the LAST non-blank line of the block:
  // that is the writer's genuine block separator. A "---" with more content after
  // it is body text (a visual divider) and must be preserved verbatim - scanning
  // for the FIRST "---" silently truncated such bodies.
  let bodyEndIdx = lines.length;
  let lastNonBlankIdx = -1;
  for (let i = lines.length - 1; i >= bodyStartIdx; i--) {
    if (lines[i]?.trim() !== "") {
      lastNonBlankIdx = i;
      break;
    }
  }
  if (lastNonBlankIdx !== -1 && lines[lastNonBlankIdx]?.trim() === "---") {
    bodyEndIdx = lastNonBlankIdx;
  }

  // Body: trim the trailing blank line(s) before ---
  let bodyLines = lines.slice(bodyStartIdx, bodyEndIdx);
  // Remove trailing empty lines from body (the blank line between body and ---)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
    bodyLines = bodyLines.slice(0, -1);
  }
  let body = bodyLines.join("\n");

  // Stage 4: Try to parse the metadata region as YAML
  let card: DecisionCard | undefined = undefined;
  let actionCard: ActionCard | undefined = undefined;

  if (rawMeta) {
    try {
      const parsed: unknown = YAML.parse(rawMeta);

      // Stage 5: zod safeParse, so the never-throw contract holds
      if (parsed !== null && typeof parsed === "object") {
        const rawObj = parsed as Record<string, unknown>;

        // Try decision schema FIRST: it wins when both ids are present.
        const cardResult = CardSchema.safeParse(parsed);
        if (cardResult.success) {
          // If both decision-id and action-id are present, warn and treat as decision.
          if (rawObj["action-id"] !== undefined) {
            console.warn(
              "[parseBlock] block has both decision-id and action-id - treating as decision card (decision wins)"
            );
          }

          const data = cardResult.data;
          // Extract the answered field from the raw YAML object (not from CardSchema,
          // which strips unknown fields). answered: is set by applyAnswer writeback.
          const answeredRaw = rawObj["answered"];
          const answered =
            typeof answeredRaw === "string" && answeredRaw.trim() !== ""
              ? answeredRaw.trim()
              : undefined;

          // Read custom-answer appended by applyCustomAnswer.
          // The value is JSON.stringify-encoded in rawMeta (so colons and quotes are
          // safe in YAML), but YAML already decodes the double-quoted string, so
          // customAnswerRaw is the YAML-decoded value. We use it directly as a string.
          // No JSON.parse needed here because YAML has already unquoted the value.
          let customAnswer: string | undefined = undefined;
          const customAnswerRaw = rawObj["custom-answer"];
          if (typeof customAnswerRaw === "string" && customAnswerRaw.trim() !== "") {
            customAnswer = customAnswerRaw;
          }

          // Thread C: decision cards gained dismiss + superseded terminal states.
          // Written by applyDismissDecision / applySupersedeDecision, parsed with
          // the same tolerant discipline as the action side.
          const dismissed = readMetaTimestamp(rawObj, "dismissed");
          const dismissReason = decodeJsonMetaString(rawObj, "dismiss-reason");
          const superseded = readMetaTimestamp(rawObj, "superseded");
          const supersedeNote = decodeJsonMetaString(rawObj, "supersede-note");

          card = {
            decisionId: data["decision-id"],
            options: data.options.map((opt) => ({
              key: opt.key,
              label: opt.label,
              detail: opt.detail,
            })),
            answered,
            customAnswer,
            dismissed,
            dismissReason,
            superseded,
            supersedeNote,
          };
        } else {
          // Decision schema failed - try action schema.
          const actionResult = ActionSchema.safeParse(parsed);
          if (actionResult.success) {
            const data = actionResult.data;
            // Extract done timestamp from the raw YAML object (written by applyDone).
            // Tolerant of hand-written `done: true` (YAML decodes a bare true to
            // boolean) - agents hand-write it regardless of the documented
            // `done: <ISO>` shape, and a string-only parse rendered those cards
            // not-done while applyDone's raw-line guard no-opped every click
            // (kink #6's perfect lock). Boolean true counts as done, with the
            // block timestamp as the doneAt fallback.
            const doneRaw = rawObj["done"];
            const done =
              typeof doneRaw === "string" && doneRaw.trim() !== ""
                ? doneRaw.trim()
                : doneRaw === true
                  ? header.timestamp
                  : undefined;

            // Extract dismissed timestamp (written by applyDismiss). Tolerant.
            const dismissedRaw = rawObj["dismissed"];
            const dismissed =
              typeof dismissedRaw === "string" && dismissedRaw.trim() !== ""
                ? dismissedRaw.trim()
                : undefined;

            // dismiss-reason + done-note: YAML.parse already decoded the
            // JSON-encoded string, so read each directly (see decodeJsonMetaString).
            const dismissReason = decodeJsonMetaString(rawObj, "dismiss-reason");
            const doneNote = decodeJsonMetaString(rawObj, "done-note");

            // Thread C: action cards gained a superseded terminal state.
            const superseded = readMetaTimestamp(rawObj, "superseded");
            const supersedeNote = decodeJsonMetaString(rawObj, "supersede-note");

            actionCard = {
              actionId: data["action-id"],
              // Pinned vocabulary with tolerant fallback:
              // unknown values warn + normalise to "normal", never skip.
              priority: normalisePriority(data.priority, data["action-id"]),
              ticket: data.ticket,
              done,
              dismissed,
              dismissReason,
              doneNote,
              superseded,
              supersedeNote,
            };
          }
          // Both schemas failed -> card and actionCard remain undefined (plain bubble)
        }
      } else {
        // YAML parsed to null or a non-object (e.g. a bare string): the "meta region"
        // is plain body text, not frontmatter. Prepend it to the body and clear rawMeta.
        const prefix = rawMeta + (body ? "\n" + body : "");
        body = prefix;
        rawMeta = "";
      }
    } catch {
      // YAML.parse threw: the "meta region" is not valid YAML. Treat it as body text.
      const prefix = rawMeta + (body ? "\n" + body : "");
      body = prefix;
      rawMeta = "";
    }
  }
  // Empty rawMeta -> no card (plain message is normal case, not error)

  // Extract normalised ticket id from rawMeta (block-level, independent of card type).
  // ticket: line may appear in the meta region of any block (plain, decision, action).
  // The value is normalised via normaliseTicket; unrecognised values warn + field absent.
  // rawMeta is preserved verbatim for round-trip fidelity.
  let ticket: string | undefined = undefined;
  if (rawMeta) {
    const ticketLineMatch = /^ticket:\s*(.+)$/m.exec(rawMeta);
    if (ticketLineMatch) {
      const raw_ticket_value = ticketLineMatch[1]?.trim() ?? "";
      const normalised = normaliseTicket(raw_ticket_value);
      if (normalised !== null) {
        ticket = normalised;
      }
      // null from normaliseTicket means warn + absent (already handled inside normaliseTicket)
    }
  }

  return {
    header,
    body,
    card,
    actionCard,
    ticket,
    rawMeta,
    rawBlock: raw,
  };
}
