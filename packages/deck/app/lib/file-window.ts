/**
 * file-window.ts - PURE row-windowing math for the Files panel virtualization.
 *
 * No react, no DOM, no IO. Safe in the client bundle AND unit-testable in the
 * node vitest env (which has no jsdom). That testability is exactly why the
 * windowing is a pure function here rather than delegated to a DOM-measuring
 * library like react-window: react-window's FixedSize/VariableSize list would
 * work functionally (its itemSize is the same bimodal function below), but the
 * node test idiom cannot mount and assert its DOM output - it CAN assert this
 * pure computeWindow directly, which is what the bounded-mount acceptance
 * criterion needs.
 *
 * Row height is bimodal and derivable from the row's extension (a full-bleed
 * image tile vs a text/media-object row), so the cumulative offsets are
 * exact-from-data - no per-row measurement, no drift.
 *
 * ASCII only - no em-dashes (FND-05).
 */

/** Extensions that render as a full-bleed image tile (must match FilesPanel). */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** True when a row of this extension renders as an image tile. */
export function isImageRowExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

/** Height (px) of a full-bleed image tile row (h-44 tile + 1px border). */
export const IMAGE_ROW_HEIGHT = 177;

/**
 * Height (px) of a text/media-object row: the size-11 icon column dominates the
 * content, plus py-2 padding and the 1px bottom border. The description is
 * clamped to two lines (line-clamp-2 in FilesPanel) so this stays uniform.
 */
export const TEXT_ROW_HEIGHT = 88;

/** Extra rows mounted above and below the visible range to hide scroll seams. */
export const DEFAULT_OVERSCAN = 6;

/** The rendered height of one row, derived purely from its extension. */
export function rowHeight(ext: string): number {
  return isImageRowExt(ext) ? IMAGE_ROW_HEIGHT : TEXT_ROW_HEIGHT;
}

export interface WindowResult {
  /** First row index to mount (inclusive). */
  start: number;
  /** One past the last row index to mount (exclusive). */
  end: number;
  /** Spacer height (px) standing in for the rows before `start`. */
  topPad: number;
  /** Spacer height (px) standing in for the rows from `end` onward. */
  bottomPad: number;
  /** Total virtual height (px) of the full list. */
  totalHeight: number;
}

/**
 * Compute which rows to mount for a scroll position, plus the two spacer
 * heights that stand in for the un-mounted rows.
 *
 * The mounted-row count is bounded by roughly viewportHeight / min-row-height
 * plus 2 * overscan, independent of how many rows the manifest holds - so a
 * 300-reference thread mounts a small, bounded window, never 300 FileRow
 * components at once.
 *
 * @param rowExts - the ordered rows' extensions (drives per-row height)
 * @param scrollTop - the scroll container's current scrollTop (px)
 * @param viewportHeight - the scroll container's visible height (px)
 * @param overscan - extra rows each side of the visible range
 */
export function computeWindow(
  rowExts: string[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number = DEFAULT_OVERSCAN,
): WindowResult {
  const n = rowExts.length;

  // Prefix offsets: offsets[i] = summed height of rows [0, i).
  const offsets = new Array<number>(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    offsets[i + 1] = offsets[i]! + rowHeight(rowExts[i]!);
  }
  const totalHeight = offsets[n]!;

  if (n === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 };
  }

  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);

  // First row whose bottom edge is past the viewport top.
  let start = 0;
  while (start < n && offsets[start + 1]! <= top) start++;

  // First row whose top edge is at or past the viewport bottom.
  let end = start;
  while (end < n && offsets[end]! < bottom) end++;

  start = Math.max(0, start - overscan);
  end = Math.min(n, end + overscan);

  return {
    start,
    end,
    topPad: offsets[start]!,
    bottomPad: totalHeight - offsets[end]!,
    totalHeight,
  };
}
