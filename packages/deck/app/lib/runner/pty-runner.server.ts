import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BaseRunner, LaunchFailure, type SessionSpec, type WriteResult } from "./runner.js";

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

function resolveCommand({ command, cwd, env }: SessionSpec): string {
  if (!command || !cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new LaunchFailure("start-failed", "A command and an existing working directory are required.");
  }
  const directories = command.includes("/") ? [""] : (env.PATH ?? "/bin:/usr/bin").split(":");
  for (const directory of directories) {
    const candidate = resolve(cwd, directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new LaunchFailure("start-failed", "The PTY command is not executable.");
}

export class PtyRunner extends BaseRunner {
  readonly kind = "pty";
  private terminal?: NativeTerminal;

  constructor(private readonly beforeSpawn?: () => void) { super(); }

  protected async start(spec: SessionSpec): Promise<number> {
    if (process.platform !== "linux") {
      throw new LaunchFailure("unavailable", "The PTY runner is verified only on Linux.");
    }
    const binding = loadNodePty();
    const { args, cwd, env } = spec;
    const command = resolveCommand(spec);
    this.beforeSpawn?.();
    // A native spawn exception may follow child creation. Keep the spawning
    // claim: without a PID, rolling it back cannot prove there is no child.
    const terminal = binding.spawn(command, args, {
      cwd, env: { ...env }, cols: spec.cols ?? 80, rows: spec.rows ?? 24, encoding: null,
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
