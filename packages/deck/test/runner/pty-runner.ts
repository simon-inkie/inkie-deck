import { createRequire } from "node:module";
import { fixtureCommand } from "./fixture-command.js";
import { FixtureRunner, LaunchFailure, type SessionSpec, type WriteResult } from "./runner.js";

const require = createRequire(import.meta.url);
const keys: Record<string, string> = {
  Up: "\x1b[A", Down: "\x1b[B", Enter: "\r", Escape: "\x1b", Tab: "\t", BTab: "\x1b[Z",
};

interface NativeTerminal {
  pid: number;
  onData(callback: (chunk: Buffer) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(text: string): void;
  resize(cols: number, rows: number): void;
}

interface NativeBinding {
  spawn(file: string, args: string[], options: {
    cwd: string; env: Record<string, string>; cols: number; rows: number; encoding: null;
  }): NativeTerminal;
}

export function loadNodePty(): NativeBinding {
  try {
    return require("node-pty");
  } catch (error) {
    throw new LaunchFailure("unavailable", `Could not load node-pty: ${String(error)}`, error);
  }
}

export class PtyRunner extends FixtureRunner {
  readonly kind = "pty";
  private terminal?: NativeTerminal;

  constructor(private readonly directory: string) { super(); }

  protected async start(spec: SessionSpec): Promise<number> {
    if (process.platform !== "linux") {
      throw new LaunchFailure("unavailable", "The PTY fixture runner is verified only on Linux.");
    }
    const binding = loadNodePty();
    const { file, args, env } = fixtureCommand(this.directory, spec);
    const terminal = binding.spawn(file, args, {
      cwd: this.directory, env, cols: spec.cols ?? 80, rows: spec.rows ?? 24, encoding: null,
    });
    this.terminal = terminal;
    const output = terminal.onData((chunk) => this.data(chunk));
    const exit = terminal.onExit(({ exitCode, signal }) => {
      output.dispose();
      exit.dispose();
      void this.finish({ code: signal ? null : exitCode, signal: signal || null });
    });
    return terminal.pid;
  }

  protected async dispose(): Promise<void> { this.terminal = undefined; }

  protected send(value: string, named: boolean): WriteResult {
    this.terminal!.write(named ? keys[value]! : value);
    return { status: "written" };
  }

  protected setSize(cols: number, rows: number): void { this.terminal!.resize(cols, rows); }

  protected interrupt(): void { this.terminal!.write("\x03"); }
}
