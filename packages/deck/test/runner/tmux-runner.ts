import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  buildCaptureViewportArgs, buildSendKeysNamedArgs, buildSendKeysTextArgs,
  SHELL_PROMPT_RE, type PaneKey,
} from "../../app/lib/tmux.server.js";
import { fixtureCommand, fixtureEnvironment } from "./fixture-command.js";
import { FixtureRunner, type ExitInfo, type SessionSpec, type WriteResult } from "./runner.js";

const session = "fixture";
const window = "agent";
const target = `=${session}:=${window}`;
const startupMs = 10_000;
const readinessMs = 10_000;
const commandMs = 2000;
const exitPollMs = 15;
const exitProbeMs = 500;
const stopWaitMs = 3000;
const shutdownMs = 1000;
const paneExitFormat = "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}";
const exitWrapper = fileURLToPath(new URL("./fixture-exit.mjs", import.meta.url));
const commandOptions = { encoding: "utf8", killSignal: "SIGKILL", timeout: commandMs } as const;
const commands = { execFile, execFileSync, spawn };

function track<Child extends ChildProcess>(child: Child) {
  child.on("error", () => {});
  return { child, closed: new Promise<void>((resolve) => child.once("close", resolve)) };
}

function alive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function closesWithin(closed: Promise<void>, ms: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([closed.then(() => true), delay(ms, false, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

function decodeOutput(text: string): Buffer {
  return Buffer.from(text.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  ), "latin1");
}

export class TmuxRunner extends FixtureRunner {
  readonly kind = "tmux";
  private readonly socket: string;
  private readonly statusFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private server?: ReturnType<typeof track>;
  private control?: ReturnType<typeof track>;
  private display?: (format: string, timeout: number) => Promise<string | undefined>;
  private poll?: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;
  private drainOutput = false;
  private disposing = false;

  constructor(private readonly directory: string, private readonly tmux = commands) {
    super(readinessMs);
    this.socket = join(directory, "tmux.sock");
    this.statusFile = join(directory, "fixture-exit");
    this.env = fixtureEnvironment(directory);
  }

  private run(...args: string[]): string {
    return this.tmux.execFileSync("tmux", ["-N", "-S", this.socket, ...args], {
      ...commandOptions, env: this.env, stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private async query(...args: string[]): Promise<string> {
    const timer = new AbortController();
    try {
      const response = new Promise<string>((resolve, reject) => {
        this.tmux.execFile("tmux", ["-N", "-S", this.socket, ...args],
          { ...commandOptions, env: this.env }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      return await Promise.race([response, delay(commandMs, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`Private tmux command timed out: ${args[0]}.`);
      })]);
    } finally {
      timer.abort();
    }
  }

  protected async start(spec: SessionSpec): Promise<number> {
    const { file, args, env } = fixtureCommand(this.directory, spec);
    const deadline = performance.now() + startupMs;
    this.server = track(this.tmux.spawn("tmux", ["-D", "-S", this.socket, "-f", "/dev/null", "-u"], {
      cwd: this.directory, env, stdio: "ignore",
    }));
    await this.untilStarted(this.server.child, deadline, "start the private tmux server", async () => {
      await this.query("set-option", "-gw", "remain-on-exit", "on");
      return true;
    });
    const control = this.tmux.spawn("tmux", ["-N", "-S", this.socket, "-u", "-C", "new-session",
      "-s", session, "-n", window, "-c", this.directory,
      "-x", String(spec.cols ?? 80), "-y", String(spec.rows ?? 24),
      "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      process.execPath, exitWrapper, this.statusFile, file, ...args,
    ], { env, stdio: ["pipe", "pipe", "ignore"] });
    this.control = track(control);
    control.stdin.on("error", () => {});
    control.stdout.setEncoding("latin1");
    const lines = createInterface({ input: control.stdout });
    let sequence = 0;
    this.display = async (format, timeout) => {
      if (!alive(control) || !control.stdin.writable) return;
      const tag = `fixture-display-${++sequence}:`;
      return new Promise<string | undefined>((resolve) => {
        const finish = (response?: string) => {
          clearTimeout(timer);
          lines.off("line", onLine);
          control.off("close", onClose);
          resolve(response);
        };
        const onLine = (line: string) => {
          if (line.startsWith(tag)) finish(line.slice(tag.length));
        };
        const onClose = () => finish();
        const timer = setTimeout(onClose, timeout);
        lines.on("line", onLine);
        control.once("close", onClose);
        control.stdin.write(`display-message -p -t ${target} '${tag}${format}'\n`);
      });
    };
    lines.on("line", (line) => {
      const output = /^%output %\d+ (.*)$/.exec(line);
      if (output) this.data(decodeOutput(output[1]!));
    });
    const pid = await this.untilStarted(control, deadline, "find the fixture pane", async () => {
      const recorded = this.readExit();
      if (recorded) return recorded.pid;
      const pid = Number((await this.query("display-message", "-p", "-t", target, "#{pane_pid}")).trim());
      return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
    }).catch((error: unknown) => {
      const recorded = this.readExit();
      if (recorded) return recorded.pid;
      throw error;
    });
    this.schedulePoll();
    return pid;
  }

  private async untilStarted<Value>(child: ChildProcess, deadline: number, action: string,
    probe: () => Promise<Value | undefined>): Promise<Value> {
    let cause: unknown;
    while (alive(child) && performance.now() < deadline) {
      try {
        const value = await probe();
        if (value !== undefined) return value;
      } catch (error) {
        cause = error;
      }
      await delay(25);
    }
    throw new Error(`Could not ${action}.`, { cause });
  }

  private schedulePoll(): void {
    if (!this.disposing) this.poll = setTimeout(() => { void this.checkExit(); }, exitPollMs);
  }

  private readExit(): { pid: number; info: ExitInfo } | undefined {
    try {
      const fields = /^(\d+) (\d+) (\d+)\n$/.exec(readFileSync(this.statusFile, "utf8"));
      if (!fields) return;
      const pid = Number(fields[1]);
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      const code = Number(fields[2]);
      const signal = Number(fields[3]);
      return { pid, info: signal ? { code: null, signal } : { code, signal: null } };
    } catch {
      return;
    }
  }

  private async checkExit(): Promise<void> {
    let response: string | undefined;
    try {
      response = await this.display?.(paneExitFormat, exitProbeMs);
    } catch {}
    if (this.disposing) return;
    const [dead, status, signal] = response?.trimEnd().split(" ") ?? [];
    let info = dead === "0" ? undefined : this.readExit()?.info;
    if (dead === "1" || info) this.drainOutput = true;
    if (!info && dead === "1") {
      const signalName = signal?.startsWith("SIG") ? signal : `SIG${signal}`;
      const signalNumber = Number(signal) || constants.signals[signalName as NodeJS.Signals];
      if (signalNumber && signalNumber > 0) info = { code: null, signal: signalNumber };
      else if (status && /^\d+$/.test(status)) info = { code: Number(status), signal: null };
    }
    if (info) await this.finish(info);
    else this.schedulePoll();
  }

  protected override onStopRequested(): void {
    this.stopTimer = setTimeout(() => {
      const recorded = this.readExit();
      if (recorded) this.drainOutput = true;
      void this.finish(recorded?.info ?? { code: null, signal: null });
    }, stopWaitMs);
  }

  protected async dispose(): Promise<void> {
    this.disposing = true;
    clearTimeout(this.poll);
    clearTimeout(this.stopTimer);
    const children = [this.server, this.control].filter((tracked) => tracked !== undefined);
    const closed = Promise.all(children.map((tracked) => tracked.closed)).then(() => {});
    if (this.drainOutput) await this.display?.("drained", commandMs).catch(() => {});
    if (this.server && alive(this.server.child)) {
      await this.query("kill-server").catch(() => {});
    }
    if (await closesWithin(closed, shutdownMs)) return;
    for (const { child } of children) {
      if (alive(child)) child.kill("SIGKILL");
    }
    if (!await closesWithin(closed, shutdownMs)) {
      for (const { child } of children) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.unref();
      }
      throw new Error("Private tmux processes did not close after SIGKILL.");
    }
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
