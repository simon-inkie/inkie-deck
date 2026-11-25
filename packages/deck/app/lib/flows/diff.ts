/**
 * diff.ts - Pure deterministic unified line diff for flow YAML templates and drafts.
 *
 * ZERO .server or Node imports - safe for both client and server bundles.
 * ASCII only - no em-dashes.
 */

/**
 * Compute a deterministic unified line diff between baseYaml and draftYaml.
 * Pure function with zero subprocess or I/O dependencies.
 */
export function computeUnifiedDiff(
  baseYaml: string,
  draftYaml: string,
  baseLabel = "base.yaml",
  draftLabel = "draft.yaml",
  contextLines = 3,
): string {
  const splitLines = (text: string): string[] => {
    if (text.length === 0) return [];
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  };

  const a = splitLines(baseYaml);
  const b = splitLines(draftYaml);
  const m = a.length;
  const n = b.length;

  // Compute LCS DP table (flow YAML files are small: typically < 500 lines)
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        row[j] = nextRow[j + 1]! + 1;
      } else {
        const down = nextRow[j]!;
        const right = row[j + 1]!;
        row[j] = down >= right ? down : right;
      }
    }
  }

  type EditOp = { kind: " " | "-" | "+"; line: string; oldLine: number; newLine: number };
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]!, oldLine: i + 1, newLine: j + 1 });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: "-", line: a[i]!, oldLine: i + 1, newLine: j + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: "+", line: b[j]!, oldLine: i + 1, newLine: j + 1 });
    j++;
  }

  const changedIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.kind !== " ") changedIndices.push(idx);
  }

  if (changedIndices.length === 0) {
    return `--- ${baseLabel}\n+++ ${draftLabel}\n`;
  }

  // Group changed indices into unified hunks with contextLines
  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const output: string[] = [`--- ${baseLabel}`, `+++ ${draftLabel}`];
  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end + 1);
    let oldCount = 0;
    let newCount = 0;
    let oldStart = slice[0]!.oldLine;
    let newStart = slice[0]!.newLine;
    for (const op of slice) {
      if (op.kind === " " || op.kind === "-") oldCount++;
      if (op.kind === " " || op.kind === "+") newCount++;
    }
    if (oldCount === 0) oldStart = Math.max(0, oldStart - 1);
    if (newCount === 0) newStart = Math.max(0, newStart - 1);
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      output.push(`${op.kind}${op.line}`);
    }
  }
  return output.join("\n") + "\n";
}
