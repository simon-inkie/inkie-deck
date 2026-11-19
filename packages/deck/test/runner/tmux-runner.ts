import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildCaptureViewportArgs, buildSendKeysNamedArgs, buildSendKeysTextArgs,
  SHELL_PROMPT_RE, TMUX_EXEC_TIMEOUT_MS, type PaneKey,
} from "../../app/lib/tmux.server.js";
import { fixtureCommand, fixtureEnvironment } from "./fixture-command.js";
import { FixtureRunner, type ExitInfo, type SessionSpec, type WriteResult } from "./runner.js";

const session = "fixture";
const window = "agent";
const target = `=${session}:=${window}`;
const startupMs = 4000;
const readinessMs = 5000;
const statusGraceMs = 1000;
const exitWaitMs = 3000;
const shutdownMs = 1000;
const outputBarrier = "fixture-output-drained";
const unknownExit: ExitInfo = { code: null, signal: null };
const commandOptions = { encoding: "utf8", killSignal: "SIGKILL", timeout: TMUX_EXEC_TIMEOUT_MS } as const;
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
  private readonly env: NodeJS.ProcessEnv;
  private server?: ReturnType<typeof track>;
  private control?: ReturnType<typeof track>;
  private drainOutput?: () => Promise<void>;
  private poll?: NodeJS.Timeout;
  private exitTimer?: NodeJS.Timeout;
  private deadSince?: number;
  private probeFailedSince?: number;
  private disposing = false;

  constructor(private readonly directory: string, private readonly tmux = commands) {
    super(readinessMs);
    this.socket = join(directory, "tmux.sock");
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
      return await Promise.race([response, delay(TMUX_EXEC_TIMEOUT_MS, undefined, { signal: timer.signal }).then(() => {
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
      "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), file, ...args,
    ], { env, stdio: ["pipe", "pipe", "ignore"] });
    const trackedControl = this.control = track(control);
    control.stdin.on("error", () => {});
    control.stdout.setEncoding("latin1");
    const lines = createInterface({ input: control.stdout });
    const outputDrained = new Promise<void>((resolve) => {
      lines.on("line", (line) => { if (line === outputBarrier) resolve(); });
    });
    this.drainOutput = async () => {
      if (!alive(control)) return;
      control.stdin.write(`display-message -p ${outputBarrier}\n`);
      await closesWithin(Promise.race([outputDrained, trackedControl.closed]), TMUX_EXEC_TIMEOUT_MS);
    };
    lines.on("line", (line) => {
      const output = /^%output %\d+ (.*)$/.exec(line);
      if (output) this.data(decodeOutput(output[1]!));
    });
    const pid = await this.untilStarted(control, deadline, "find the fixture pane", async () => {
      const pid = Number((await this.query("display-message", "-p", "-t", target, "#{pane_pid}")).trim());
      return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
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
    if (!this.disposing) this.poll = setTimeout(() => { void this.checkExit(); }, 25);
  }

  private async checkExit(): Promise<void> {
    let info: ExitInfo | undefined;
    try {
      const [dead, status, signal] = (await this.query("display-message", "-p", "-t", target,
        "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}")).trimEnd().split(" ");
      if (dead !== "0" && dead !== "1") throw new Error("tmux did not report pane state.");
      this.probeFailedSince = undefined;
      if (dead === "1") {
        this.deadSince ??= performance.now();
        const signalName = signal?.startsWith("SIG") ? signal : `SIG${signal}`;
        const signalNumber = Number(signal) || constants.signals[signalName as NodeJS.Signals];
        if (signalNumber && signalNumber > 0) info = { code: null, signal: signalNumber };
        else if (status && /^\d+$/.test(status)) info = { code: Number(status), signal: null };
      }
    } catch {
      this.probeFailedSince ??= performance.now();
    }
    if (this.disposing) return;
    const now = performance.now();
    if (info) await this.finish(info);
    else if (now - (this.deadSince ?? this.probeFailedSince ?? now) >= statusGraceMs) await this.finish(unknownExit);
    else this.schedulePoll();
  }

  override exited(): Promise<ExitInfo> {
    if (!this.disposing) this.exitTimer ??= setTimeout(() => { void this.finish(unknownExit); }, exitWaitMs);
    return super.exited();
  }

  protected async dispose(): Promise<void> {
    this.disposing = true;
    clearTimeout(this.poll);
    clearTimeout(this.exitTimer);
    const children = [this.server, this.control].filter((tracked) => tracked !== undefined);
    const closed = Promise.all(children.map((tracked) => tracked.closed)).then(() => {});
    if (this.deadSince !== undefined) await this.drainOutput?.().catch(() => {});
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
