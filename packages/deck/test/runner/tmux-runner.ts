import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { constants } from "node:os";
import {
  buildCaptureViewportArgs, buildSendKeysNamedArgs, buildSendKeysTextArgs,
  SHELL_PROMPT_RE, TMUX_EXEC_TIMEOUT_MS, type PaneKey,
} from "../../app/lib/tmux.server.js";
import { fixtureCommand } from "./fixture-command.js";
import { FixtureRunner, type SessionSpec, type WriteResult } from "./runner.js";

const session = "fixture";
const window = "agent";
const target = `=${session}:=${window}`;

function closed(child: ChildProcess): Promise<void> {
  child.on("error", () => {});
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function decodeOutput(text: string): Buffer {
  return Buffer.from(text.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  ), "latin1");
}

export class TmuxRunner extends FixtureRunner {
  readonly kind = "tmux";
  private readonly socket: string;
  private server?: ChildProcess;
  private serverClosed?: Promise<void>;
  private outputClosed?: Promise<void>;
  private poll?: NodeJS.Timeout;

  constructor(private readonly directory: string) {
    super();
    this.socket = join(directory, "tmux.sock");
  }

  private run(...args: string[]): string {
    return execFileSync("tmux", ["-N", "-S", this.socket, ...args], {
      encoding: "utf8", timeout: TMUX_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
    });
  }

  protected async start(spec: SessionSpec): Promise<number> {
    const { file, args, env } = fixtureCommand(this.directory, spec);
    this.server = spawn("tmux", ["-D", "-S", this.socket, "-f", "/dev/null"], {
      cwd: this.directory, env, stdio: "ignore",
    });
    this.serverClosed = closed(this.server);
    const socketDeadline = Date.now() + 1000;
    while (!existsSync(this.socket) && Date.now() < socketDeadline) {
      await Promise.race([delay(10), this.serverClosed]);
      if (!this.server.pid || this.server.exitCode !== null || this.server.signalCode !== null) break;
    }
    this.run("set-option", "-gw", "remain-on-exit", "on");
    const control = spawn("tmux", ["-N", "-S", this.socket, "-C", "new-session",
      "-s", session, "-n", window, "-c", this.directory,
      "-x", String(spec.cols ?? 80), "-y", String(spec.rows ?? 24),
      "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), file, ...args,
    ], { env, stdio: ["pipe", "pipe", "ignore"] });
    this.outputClosed = closed(control);
    control.stdout.setEncoding("latin1");
    const lines = createInterface({ input: control.stdout });
    lines.on("line", (line) => {
      const output = /^%output %\d+ (.*)$/.exec(line);
      if (output) this.data(decodeOutput(output[1]!));
    });
    const paneDeadline = Date.now() + 1000;
    while (Date.now() < paneDeadline) {
      try {
        const pid = Number(this.run("display-message", "-p", "-t", target, "#{pane_pid}").trim());
        if (Number.isSafeInteger(pid) && pid > 1) {
          this.poll = setInterval(() => this.checkExit(), 25);
          return pid;
        }
      } catch {
        if (control.exitCode !== null || control.signalCode !== null) break;
      }
      await Promise.race([delay(10), this.outputClosed]);
    }
    throw new Error("Could not find the fixture pane on the private tmux socket.");
  }

  private checkExit(): void {
    try {
      const [dead, status, signal] = this.run("display-message", "-p", "-t", target,
        "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}").trimEnd().split(" ");
      if (dead !== "1") return;
      const signalNumber = signal ? Number(signal) || constants.signals[`SIG${signal}` as NodeJS.Signals] : null;
      void this.finish({ code: status ? Number(status) : null, signal: signalNumber ?? null });
    } catch {
      void this.finish({ code: null, signal: null });
    }
  }

  protected async dispose(): Promise<void> {
    clearInterval(this.poll);
    if (this.server?.pid && this.server.exitCode === null && this.server.signalCode === null) {
      try { this.run("kill-server"); } catch { this.server.kill("SIGTERM"); }
    }
    await this.serverClosed;
    await this.outputClosed;
  }

  protected send(value: string, named: boolean): WriteResult {
    if (this.run("display-message", "-p", "-t", target, "#{pane_dead}").trim() !== "0") {
      return { status: "refused", reason: "not-running" };
    }
    const viewport = this.run(...buildCaptureViewportArgs(session, window));
    if (viewport.split("\n").some((line) => SHELL_PROMPT_RE.test(line))) {
      return { status: "refused", reason: "unsafe-pane" };
    }
    this.run(...(named ? buildSendKeysNamedArgs(session, window, value as PaneKey)
      : buildSendKeysTextArgs(session, window, value)));
    return { status: "written" };
  }

  protected setSize(cols: number, rows: number): void {
    this.run("resize-window", "-t", target, "-x", String(cols), "-y", String(rows));
  }

  protected interrupt(): void { this.run("send-keys", "-t", target, "C-c"); }
}
