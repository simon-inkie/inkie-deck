/**
 * projects.server.ts
 *
 * Storage layer for the Projects kanban board.
 * Guarded by the shared confineToRootReal primitive:
 *   - realpath BOTH sides for containment
 *   - sep-suffixed startsWith prefix assert
 *   - MC_SANDBOX_ONLY live-silo refusal on the root
 *   - throw on guard failure -> caller maps to 4xx
 *
 * Exports:
 *   resolveProjectsRoot() - reads PROJECTS_ROOT env; throws if unset/relative.
 *   listCards() - flat *.md scan, YAML frontmatter parse, tolerant skip+warn.
 *   moveCard(cardId, column) - targeted line edits on column: and updated: only.
 *
 * The .server suffix keeps this module out of the client bundle.
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  atomicWrite,
  assertNoLiveSiloRoot,
  confineToRootReal,
} from "./safe-fs.server.js";
import type { ProjectCard, Column } from "./projects.shared.js";
import { VALID_COLUMNS } from "./projects.shared.js";
import { normaliseTicket } from "./ticket.js";

export type { ProjectCard, Column };
export { VALID_COLUMNS };

// ---------------------------------------------------------------------------
// resolveProjectsRoot
// ---------------------------------------------------------------------------

/**
 * Read process.env.PROJECTS_ROOT and return it as an absolute path string.
 *
 * Throws if:
 *   - PROJECTS_ROOT is unset or empty (no default).
 *   - PROJECTS_ROOT is not an absolute path (relative paths are rejected).
 */
export function resolveProjectsRoot(): string {
  const root = process.env["PROJECTS_ROOT"];
  if (!root || root.trim() === "") {
    throw new Error(
      "PROJECTS_ROOT is required but not set. " +
        "Set PROJECTS_ROOT to an absolute path to the projects directory. " +
        "There is no default."
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `PROJECTS_ROOT must be an absolute path, got: "${root}". ` +
        "Relative paths are rejected."
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// assertSafeProjectPath
// ---------------------------------------------------------------------------

/**
 * Assert that targetPath is safe to read or write within PROJECTS_ROOT.
 *
 * Now built on the shared confineToRootReal primitive in
 * safe-fs.server.ts (realpath both sides, parent-realpath + basename,
 * final-component realpath, sep-suffixed prefix assert). The substring ban
 * is gone; the MC_SANDBOX_ONLY live-silo refusal guards the root instead.
 *
 * @returns The resolved absolute path (safe to use for fs operations).
 */
export function assertSafeProjectPath(
  targetPath: string,
  options: { forWrite: boolean }
): string {
  const root = resolveProjectsRoot();
  const rootReal = fs.realpathSync(root);
  assertNoLiveSiloRoot(rootReal, "projects");

  return confineToRootReal(targetPath, rootReal, {
    forWrite: options.forWrite,
    label: "projects",
    notFound: `Project card not found: "${targetPath}".`,
  });
}

// ---------------------------------------------------------------------------
// listCards
// ---------------------------------------------------------------------------

/**
 * Read all *.md files in PROJECTS_ROOT (flat, v1).
 *
 * YAML frontmatter region is parsed tolerantly: a card that is malformed or
 * missing required fields is skipped with a console.warn.
 * An unknown column value renders in "todo" with a warn (visible beats vanished).
 *
 * Returns cards sorted by updated desc within each column call-site can re-sort
 * but we return them globally updated-desc for simplicity.
 */
export function listCards(): ProjectCard[] {
  const root = resolveProjectsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const cards: ProjectCard[] = [];

  for (const name of entries) {
    // Only *.md files (flat, no subdirectories).
    if (!name.endsWith(".md")) continue;

    const filePath = path.join(root, name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      console.warn(`[projects] could not read card file: "${name}" - skipped`);
      continue;
    }

    // Extract the YAML frontmatter region between the opening --- and closing ---.
    // File mtime is the updated fallback for hand-made cards (defaults-over-skip).
    let mtimeIso = "";
    try {
      mtimeIso = fs.statSync(filePath).mtime.toISOString();
    } catch {
      // unreadable stat falls through; updated default becomes empty string
    }
    const parsed = parseFrontmatter(raw, name, mtimeIso);
    if (!parsed) continue;

    // ADDITIVE: derive summary + body from the content after frontmatter.
    const { summary, body, links } = extractBodyFields(raw, name);

    cards.push({ ...parsed, id: name, summary, body, links });
  }

  // Sort updated desc.
  cards.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

  return cards;
}

// ---------------------------------------------------------------------------
// parseFrontmatter (internal)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter region of a card file.
 *
 * DEFAULTS-OVER-SKIP: skip (null + warn) ONLY
 * when the card is structurally not a card - no frontmatter fence, unparseable
 * YAML, or a non-object region. MISSING FIELDS get defaults instead of a skip
 * (title <- filename sans .md, agent <- "unassigned", updated <- file mtime,
 * column <- "todo") so a half-filled hand-made card stays VISIBLE on the board
 * rather than vanishing - vanishing is the board's own anti-principle.
 */
function parseFrontmatter(
  raw: string,
  filename: string,
  fallbackUpdated: string
): Omit<ProjectCard, "id" | "summary" | "body" | "links"> | null {
  // Frontmatter region: content between the first "---" and the next "---".
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    console.warn(
      `[projects] card "${filename}" has no frontmatter region - skipped`
    );
    return null;
  }

  const region = match[1]!;
  let parsed: unknown;
  try {
    parsed = YAML.parse(region);
  } catch {
    console.warn(
      `[projects] card "${filename}" has malformed YAML frontmatter - skipped`
    );
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn(
      `[projects] card "${filename}" frontmatter parsed to a non-object - skipped`
    );
    return null;
  }

  const fm = parsed as Record<string, unknown>;

  // Required fields: title, agent, updated.
  const title = fm["title"];
  const agent = fm["agent"];
  const updated = fm["updated"];

  // Defaults-over-skip: missing fields default, with a warn, so the card
  // stays visible. Only structural failures above return null.
  let titleStr: string;
  if (title && typeof title === "string") {
    titleStr = title;
  } else {
    console.warn(
      `[projects] card "${filename}" missing "title" - defaulting to filename`
    );
    titleStr = filename.replace(/\.md$/, "");
  }

  let agentStr: string;
  if (agent && typeof agent === "string") {
    agentStr = agent;
  } else {
    console.warn(
      `[projects] card "${filename}" missing "agent" - defaulting to "unassigned"`
    );
    agentStr = "unassigned";
  }

  // Normalise updated to a string (YAML may parse ISO dates as Date objects);
  // missing updated falls back to file mtime (defaults-over-skip).
  let updatedStr: string;
  if (!updated) {
    console.warn(
      `[projects] card "${filename}" missing "updated" - defaulting to file mtime`
    );
    updatedStr = fallbackUpdated;
  } else {
    updatedStr =
      updated instanceof Date
        ? updated.toISOString()
        : typeof updated === "string"
          ? updated
          : String(updated);
  }

  // Column: validate against known list; tolerate unknown with warn.
  const columnRaw = fm["column"];
  let column: Column;
  if (typeof columnRaw === "string" && VALID_COLUMNS.includes(columnRaw as Column)) {
    column = columnRaw as Column;
  } else {
    if (columnRaw !== undefined) {
      console.warn(
        `[projects] card "${filename}" unknown column "${columnRaw}" - rendering as "todo"`
      );
    } else {
      console.warn(
        `[projects] card "${filename}" missing "column" field - rendering as "todo"`
      );
    }
    column = "todo";
  }

  // Optional human assignee (tolerant - absent on old cards).
  const assignee =
    typeof fm["assignee"] === "string" && fm["assignee"].trim() !== ""
      ? fm["assignee"].trim().toLowerCase()
      : undefined;

  // Optional ticket (raw value preserved; normalised id derived at read time).
  const ticket =
    typeof fm["ticket"] === "string" && fm["ticket"].trim() !== ""
      ? fm["ticket"]
      : undefined;

  // ADDITIVE: normalised ticket id, derived from ticket: at read time.
  // File value is untouched; both bare ids and Linear URLs are accepted.
  const ticketId = ticket !== undefined ? (normaliseTicket(ticket) ?? undefined) : undefined;

  // ADDITIVE: optional blocked-on: key. Tolerant: non-string warns + ignored.
  let blockedOn: string | undefined = undefined;
  const blockedOnRaw = fm["blocked-on"];
  if (blockedOnRaw !== undefined) {
    if (typeof blockedOnRaw === "string" && blockedOnRaw.trim() !== "") {
      blockedOn = blockedOnRaw.trim();
    } else if (typeof blockedOnRaw !== "string") {
      console.warn(
        `[projects] card "${filename}" "blocked-on:" is not a string (${typeof blockedOnRaw}) - ignored`
      );
    }
  }

  return { title: titleStr, agent: agentStr, column, ticket, ticketId, updated: updatedStr, blockedOn, assignee };
}

// ---------------------------------------------------------------------------
// extractBodyFields (internal)
// ---------------------------------------------------------------------------

/**
 * Extract summary, body, and links from a raw card file string.
 *
 * summary: first non-empty paragraph of the body, truncated to ~140 chars.
 * body:    full body text (everything after the frontmatter closing ---).
 * links:   optional frontmatter "links:" key parsed as string list.
 *          Non-list values warn + return undefined.
 *          Non-string entries in a list warn + are filtered out.
 *          Absent key returns undefined.
 *
 * Tolerant reader (defaults-over-skip family): bad links: values degrade
 * to absent rather than failing the card.
 */
function extractBodyFields(
  raw: string,
  filename: string
): { summary: string; body: string; links?: string[] } {
  // Extract body: everything after the closing --- of the frontmatter.
  // The same regex used in parseFrontmatter: opening ---, region, closing ---.
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const body = fmMatch
    ? raw.slice(fmMatch[0].length).trimEnd()
    : "";

  // Summary: first non-empty paragraph of the body, truncated to 140 chars.
  const firstPara = body
    .split(/\n\n+/)
    .map((p) => p.trim())
    .find((p) => p.length > 0) ?? "";
  // Collapse newlines within the paragraph to spaces.
  const oneLine = firstPara.replace(/\r?\n/g, " ");
  const SUMMARY_LIMIT = 140;
  const summary =
    oneLine.length <= SUMMARY_LIMIT
      ? oneLine
      : oneLine.slice(0, SUMMARY_LIMIT - 1) + "…";

  // Extract links: from frontmatter YAML (re-parse the region for this key).
  let links: string[] | undefined;
  const fmRegion = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fmRegion) {
    let fmParsed: unknown;
    try {
      fmParsed = YAML.parse(fmRegion[1]!);
    } catch {
      fmParsed = null;
    }
    if (fmParsed && typeof fmParsed === "object") {
      const fm = fmParsed as Record<string, unknown>;
      const rawLinks = fm["links"];
      if (rawLinks !== undefined) {
        if (!Array.isArray(rawLinks)) {
          console.warn(
            `[projects] card "${filename}" "links:" is not a list - ignored`
          );
        } else {
          const stringLinks: string[] = [];
          for (const entry of rawLinks) {
            if (typeof entry === "string") {
              stringLinks.push(entry);
            } else {
              console.warn(
                `[projects] card "${filename}" "links:" contains a non-string entry - filtered`
              );
            }
          }
          links = stringLinks.length > 0 ? stringLinks : undefined;
        }
      }
    }
  }

  return { summary, body, links };
}

// ---------------------------------------------------------------------------
// sanitiseCardId
// ---------------------------------------------------------------------------

/**
 * Validate and sanitise a cardId string for use as a filename.
 *
 * Rules:
 *   - Must not contain path separators (/ or \).
 *   - Must not be a dotfile (start with .).
 *   - Must end with .md.
 *
 * Throws with a descriptive message on any violation.
 */
export function sanitiseCardId(cardId: string): string {
  if (!cardId || cardId.trim() === "") {
    throw new Error("cardId must not be empty.");
  }
  if (cardId.includes("/") || cardId.includes("\\")) {
    throw new Error(
      `cardId must not contain path separators, got: "${cardId}".`
    );
  }
  if (cardId.startsWith(".")) {
    throw new Error(`cardId must not be a dotfile, got: "${cardId}".`);
  }
  if (!cardId.endsWith(".md")) {
    throw new Error(`cardId must end with ".md", got: "${cardId}".`);
  }
  return cardId;
}

// ---------------------------------------------------------------------------
// moveCard
// ---------------------------------------------------------------------------

/**
 * Move a card to a new column via TARGETED LINE EDITS.
 *
 * Only the "column:" and "updated:" lines in the frontmatter are modified.
 * Body, comments, and unknown frontmatter keys survive BYTE-IDENTICAL.
 *
 * If "column:" is absent (hand-made card without a column line), it is
 * inserted right after the opening "---". This is additive, never destructive.
 *
 * The cardId is sanitised (no separators, no dotfiles, must end .md) and the
 * final path is guarded inside PROJECTS_ROOT (containment + .the-vault ban).
 */
export function moveCard(cardId: string, column: string): void {
  // Validate cardId shape.
  sanitiseCardId(cardId);

  // Validate column value.
  if (!VALID_COLUMNS.includes(column as Column)) {
    throw new Error(
      `Invalid column "${column}". Must be one of: ${VALID_COLUMNS.join(", ")}.`
    );
  }

  const root = resolveProjectsRoot();
  const targetPath = path.join(root, cardId);

  // Guard the path (containment + .the-vault ban).
  const safePath = assertSafeProjectPath(targetPath, { forWrite: true });

  // Read the file.
  let raw: string;
  try {
    raw = fs.readFileSync(safePath, "utf8");
  } catch {
    throw new Error(`Card not found: "${cardId}".`);
  }

  const newUpdated = new Date().toISOString();

  // Apply targeted line edits.
  const result = applyTargetedEdits(raw, column as Column, newUpdated);

  // Write atomically.
  atomicWrite(safePath, result);
}

// ---------------------------------------------------------------------------
// createCard (user-created todos from the board)
// ---------------------------------------------------------------------------

/** Input for createCard. Validated here - parse, don't trust the route. */
export interface CreateCardInput {
  title: string;
  agent: string;
  assignee?: string;
  ticket?: string;
  body?: string;
}

/**
 * Create a new card file in PROJECTS_ROOT (column: todo).
 *
 * Filename derives from the title (kebab slug); on collision a numeric
 * suffix is appended rather than overwriting - cards are never clobbered.
 * Same path guards as moveCard (containment + .the-vault ban + atomicWrite).
 *
 * @returns the new card's filename (its stable id)
 */
export function createCard(input: CreateCardInput): string {
  const title = input.title.trim();
  if (title === "" || title.length > 200) {
    throw new Error("Title is required (max 200 chars).");
  }
  const agent = input.agent.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent)) {
    throw new Error("Agent must be a valid roster name.");
  }
  const assigneeRaw = input.assignee?.trim().toLowerCase();
  const assignee = assigneeRaw === "" ? undefined : assigneeRaw;
  if (assignee !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(assignee)) {
    throw new Error("Assignee must be a simple name.");
  }
  const ticketRaw = input.ticket?.trim();
  const ticket = ticketRaw === "" ? undefined : ticketRaw;
  if (ticket && !/^https:\/\/linear\.app\//.test(ticket) && !/^[A-Za-z]+-\d+$/.test(ticket)) {
    throw new Error("Ticket must be a Linear URL or an id like PROJ-123.");
  }

  const root = resolveProjectsRoot();

  // Kebab slug from the title; fall back to "todo" for degenerate input.
  const slugBase =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "todo";
  let filename = `${slugBase}.md`;
  let n = 2;
  while (fs.existsSync(path.join(root, filename))) {
    filename = `${slugBase}-${n}.md`;
    n += 1;
    if (n > 100) throw new Error("Could not find a free filename for the card.");
  }

  const targetPath = path.join(root, filename);
  const safePath = assertSafeProjectPath(targetPath, { forWrite: true });

  const updated = new Date().toISOString();
  const fmLines = [
    "---",
    `title: ${title.replace(/\n/g, " ")}`,
    `agent: ${agent}`,
    "column: todo",
    ...(assignee ? [`assignee: ${assignee}`] : []),
    ...(ticket ? [`ticket: ${ticket}`] : []),
    `updated: ${updated}`,
    "---",
  ];
  const body = (input.body ?? "").trim();
  const content = fmLines.join("\n") + "\n" + (body ? body + "\n" : "");

  atomicWrite(safePath, content);
  return filename;
}

// ---------------------------------------------------------------------------
// applyTargetedEdits (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Apply targeted edits to a card file's content:
 *   - Replace the "column: ..." line with the new column value.
 *   - Replace the "updated: ..." line with the new updated timestamp.
 *   - If "column:" is absent, insert it right after the opening "---".
 *   - If "updated:" is absent, insert it right after the opening "---" (or after
 *     the newly-inserted column line).
 *
 * BYTE-IDENTICAL contract: every byte outside these two lines is preserved.
 * Body and unknown frontmatter keys survive verbatim.
 *
 * @param raw - The raw file content.
 * @param column - The target column value.
 * @param updated - The ISO-8601 updated timestamp.
 * @returns The modified file content.
 */
export function applyTargetedEdits(
  raw: string,
  column: Column,
  updated: string
): string {
  // Detect line ending style (preserve the original).
  const crlf = raw.includes("\r\n");
  const nl = crlf ? "\r\n" : "\n";

  // Split into lines WITHOUT stripping endings; we want to preserve them.
  // We process by splitting on line boundaries and tracking positions.
  const lines = raw.split(/\r?\n/);

  // The file must OPEN with
  // the frontmatter fence. Without this check, a structural non-card whose
  // body contains a "---" horizontal rule would have that rule treated as the
  // closing fence and get column:/updated: spliced into its body - a
  // destructive write on exactly the class of file listCards excludes.
  if (lines[0] !== "---") {
    throw new Error(
      "Refusing to edit: file does not open with a frontmatter fence - not a card."
    );
  }

  // We work inside the frontmatter region (between the first --- and second ---).
  // Find the opening --- (index 0) and closing --- (first occurrence of --- after index 0).
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIdx = i;
      break;
    }
  }

  let columnLineIdx = -1;
  let updatedLineIdx = -1;

  if (closingIdx !== -1) {
    // Scan frontmatter region for existing column: and updated: lines.
    for (let i = 1; i < closingIdx; i++) {
      if (/^column:\s/.test(lines[i]!) || lines[i] === "column:") {
        columnLineIdx = i;
      }
      if (/^updated:\s/.test(lines[i]!) || lines[i] === "updated:") {
        updatedLineIdx = i;
      }
    }
  }

  // Apply targeted replacements.
  if (columnLineIdx !== -1) {
    lines[columnLineIdx] = `column: ${column}`;
  }
  if (updatedLineIdx !== -1) {
    lines[updatedLineIdx] = `updated: ${updated}`;
  }

  // If column: was absent, insert it right after the opening ---.
  if (columnLineIdx === -1 && closingIdx !== -1) {
    lines.splice(1, 0, `column: ${column}`);
    // Recompute closingIdx and updatedLineIdx after splice.
    closingIdx += 1;
    if (updatedLineIdx !== -1) updatedLineIdx += 1;
  }

  // If updated: was absent, insert it right after the opening ---.
  if (updatedLineIdx === -1 && closingIdx !== -1) {
    lines.splice(1, 0, `updated: ${updated}`);
  }

  return lines.join(nl);
}
