/**
 * compose-attach.ts - Pure helpers for the Compose attachment chip flow (TASK-450).
 *
 * buildOutgoingBody: merges typed text + attachment markdowns into a single
 * message body, blank-line separated. Attachments-only messages (empty text)
 * are legal. No trailing whitespace surprises.
 *
 * extractPasteFiles: resolves File[] from a clipboard event payload, trying
 * clipboardData.files first (file-manager copies), then clipboardData.items
 * entries of kind "file" (bitmap pastes from Snipping Tool family). Returns
 * an empty array when neither path finds anything.
 *
 * Pure module: no env, no fs, no DOM globals (FND-02 clean).
 * The ClipboardLike interface accepts plain objects so unit tests need no JSDOM.
 * ASCII only - no em-dashes (FND-05).
 */

// ---------------------------------------------------------------------------
// buildOutgoingBody
// ---------------------------------------------------------------------------

/**
 * Merge typed text and one or more attachment markdown strings into a single
 * outgoing message body.
 *
 * Rules:
 *   - Each non-empty chunk (text, then each markdown in order) is separated
 *     from the next by a single blank line (two newlines).
 *   - Chunks are trimmed so no leading/trailing whitespace leaks into the join.
 *   - An empty text + one or more markdowns is legal (attachments-only send).
 *   - Empty text + zero markdowns returns an empty string (the send-gate
 *     disabled check upstream prevents this reaching the action).
 *
 * @param text     - The typed compose text (may be empty).
 * @param markdowns - The attachment markdown strings to append.
 * @returns The merged body string.
 */
export function buildOutgoingBody(text: string, markdowns: string[]): string {
  const chunks: string[] = [];

  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    chunks.push(trimmedText);
  }

  for (const md of markdowns) {
    const trimmedMd = md.trim();
    if (trimmedMd.length > 0) {
      chunks.push(trimmedMd);
    }
  }

  return chunks.join("\n\n");
}

// ---------------------------------------------------------------------------
// extractPasteFiles
// ---------------------------------------------------------------------------

/**
 * Structural type for a clipboard items entry (avoids importing DOM types).
 * Matches the DataTransferItem interface surface we actually use.
 */
export interface ClipboardItemLike {
  kind: string;
  getAsFile(): File | null;
}

/**
 * Structural type for the clipboard data payload.
 * Accepts both the real ClipboardEvent.clipboardData and plain test objects.
 */
export interface ClipboardLike {
  files: { length: number; [index: number]: File };
  items: { length: number; [index: number]: ClipboardItemLike };
}

/**
 * Extract File[] from a clipboard data payload.
 *
 * Fallback order (matches platform reality):
 *   1. clipboardData.files - non-empty when a file-manager copy lands here.
 *   2. clipboardData.items entries where kind === "file" -> getAsFile().
 *      Filters null returns (getAsFile() returns null for non-file items).
 *      This path covers bitmap pastes (Snipping Tool etc.) which populate
 *      items but not files.
 *   3. Returns [] when neither path finds anything (e.g. plain text paste).
 *
 * Preferring files over items avoids double-reading the same payload when
 * both are populated.
 *
 * @param clipboardData - The clipboard payload (structural, not DOM-typed).
 * @returns An array of File objects extracted from the clipboard.
 */
export function extractPasteFiles(clipboardData: ClipboardLike): File[] {
  // Path 1: files collection (file-manager copies).
  if (clipboardData.files.length > 0) {
    const result: File[] = [];
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file !== undefined) {
        result.push(file);
      }
    }
    return result;
  }

  // Path 2: items of kind "file" (bitmap copies, Snipping Tool etc.).
  const result: File[] = [];
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item !== undefined && item.kind === "file") {
      const file = item.getAsFile();
      if (file !== null) {
        result.push(file);
      }
    }
  }
  return result;
}
