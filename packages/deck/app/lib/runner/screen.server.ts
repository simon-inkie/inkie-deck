import { createRequire } from "node:module";
import {
  classifyPaneSnapshot, DIM_SGR, findComposerLowerBorderIndex, findComposerOpenIndex, TMUX_CAPTURE_SCROLLBACK_LINES,
} from "../tmux.server.js";
import type { PaneSnapshot } from "../tmux-submit.js";

interface Cell {
  getChars(): string;
  isDim(): number | boolean;
}

interface Line {
  isWrapped: boolean;
  translateToString(trimRight: boolean): string;
  getCell(column: number, cell: Cell): Cell | undefined;
}

interface BufferView {
  baseY: number;
  cursorY: number;
  length: number;
  getLine(row: number): Line | undefined;
  getNullCell(): Cell;
}

interface HeadlessTerminal {
  cols: number;
  rows: number;
  buffer: { active: BufferView };
  modes: { bracketedPasteMode: boolean };
  write(chunk: Uint8Array, onParsed: () => void): void;
  dispose(): void;
}

export interface RunnerScreen {
  write(chunk: Uint8Array): void;
  capture(): string | undefined;
  composer(): PaneSnapshot | undefined;
  dispose(): void;
}

const require = createRequire(import.meta.url);
const maxPendingBytes = 1024 * 1024;
const unknownComposer = { activity: "idle", composer: "unknown" } as const;
const claudePrompt = "\u276f";

function textTone(line: Line, cell: Cell, start: number, cols: number): "dim" | "plain" | "mixed" | undefined {
  let nonSpaceDim = false;
  let nonSpaceNormal = false;
  for (let column = start; column < cols; column++) {
    const current = line.getCell(column, cell);
    if (!current) return undefined;
    if (current.getChars().trim() === "") continue;
    const dim = current.isDim();
    if (typeof dim !== "number" && typeof dim !== "boolean") return undefined;
    if (dim) nonSpaceDim = true;
    else nonSpaceNormal = true;
  }
  return nonSpaceDim ? nonSpaceNormal ? "mixed" : "dim" : "plain";
}

export function createRunnerScreen({ cols = 80, rows = 24 }: { cols?: number; rows?: number }): RunnerScreen {
  const { Terminal } = require("@xterm/headless") as {
    Terminal: new (options: {
      cols: number; rows: number; scrollback: number; allowProposedApi: boolean; logLevel: "off";
    }) => HeadlessTerminal;
  };
  const terminal = new Terminal({ cols, rows, scrollback: TMUX_CAPTURE_SCROLLBACK_LINES, allowProposedApi: true, logLevel: "off" });
  let disposed = false;
  let pendingBytes = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    terminal.dispose();
  };

  return {
    write(chunk) {
      if (disposed) return;
      const { byteLength } = chunk;
      pendingBytes += byteLength;
      // Overflow disables this session's screen and automatic sends until a
      // restart; rebuilding safely needs a complete fresh terminal snapshot.
      if (pendingBytes > maxPendingBytes) return dispose();
      try {
        terminal.write(chunk, () => { pendingBytes -= byteLength; });
      } catch {
        dispose();
      }
    },
    capture() {
      if (disposed) return undefined;
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < buffer.length; row++) {
        lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
      }
      return lines.join("\n").trimEnd();
    },
    composer() {
      if (disposed || pendingBytes !== 0) return undefined;
      try {
        if (!terminal.modes.bracketedPasteMode) return unknownComposer;
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let row = 0; row < terminal.rows; row++) {
          lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(false) ?? "");
        }
        const promptIndex = findComposerOpenIndex(lines);
        if (!lines[promptIndex]?.startsWith(claudePrompt) || buffer.cursorY < promptIndex) return unknownComposer;
        const border = findComposerLowerBorderIndex(lines, promptIndex);
        if (border < 0 || buffer.cursorY >= border) return unknownComposer;
        const cell = buffer.getNullCell();
        if (typeof cell.isDim !== "function") return unknownComposer;
        const raw = lines.slice();
        for (let row = promptIndex; row < border; row++) {
          const line = buffer.getLine(buffer.baseY + row);
          if (!line || line.isWrapped) return unknownComposer;
          const tone = textTone(line, cell, row === promptIndex ? 1 : 0, terminal.cols);
          if (tone === undefined || tone === "mixed" || (tone === "dim" && row !== promptIndex)) return unknownComposer;
          if (tone === "dim") raw[row] = DIM_SGR + raw[row];
        }
        const isGhost = raw[promptIndex]!.startsWith(DIM_SGR);
        if (isGhost && lines.slice(promptIndex + 1, border).some((line) => line.trim() !== "")) {
          return unknownComposer;
        }
        return classifyPaneSnapshot(lines.join("\n"), raw.join("\n"));
      } catch {
        return unknownComposer;
      }
    },
    dispose,
  };
}
