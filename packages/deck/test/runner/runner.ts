import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { isValidPaneKey, type PaneKey } from "../../app/lib/tmux.server.js";

export interface SessionSpec {
  scenario?: "normal" | "slow" | "failed" | "missing";
  cols?: number;
  rows?: number;
}

export interface SessionHandle { pid: number }
export interface ExitInfo { code: number | null; signal: number | null }
export type WriteResult = { status: "written" } | {
  status: "refused";
  reason: "not-running" | "invalid-key" | "unsafe-pane" | "write-failed";
};
export type StopMode = "graceful" | "kill";

export interface Runner {
  readonly kind: "tmux" | "pty";
  readonly caps: { terminalAttach: boolean; deliveryAck: false; stateEvents: false };
  launch(spec: SessionSpec): Promise<SessionHandle>;
  write(text: string): Promise<WriteResult>;
  key(name: PaneKey): Promise<WriteResult>;
  output(): AsyncIterable<Uint8Array>;
  resize(cols: number, rows: number): Promise<void>;
  cancel(): Promise<void>;
  stop(mode: StopMode): Promise<ExitInfo>;
  exited(): Promise<ExitInfo>;
}

export class LaunchFailure extends Error {
  constructor(readonly reason: "unavailable" | "start-failed", message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LaunchFailure";
  }
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

export abstract class FixtureRunner implements Runner {
  abstract readonly kind: Runner["kind"];
  readonly caps = { terminalAttach: false, deliveryAck: false, stateEvents: false } as const;
  private readonly stream = new Readable({ read() {}, objectMode: true });
  private readonly exit = deferred<ExitInfo>();
  private readonly ready = deferred<boolean>();
  private state: "new" | "starting" | "running" | "stopping" | "ended" = "new";
  private starting?: Promise<number>;
  private readinessTail = "";
  protected pid?: number;

  constructor(private readonly readinessTimeout = 3000) {}

  protected abstract start(spec: SessionSpec): Promise<number>;
  protected abstract dispose(): Promise<void>;
  protected abstract send(value: string, named: boolean): WriteResult;
  protected abstract setSize(cols: number, rows: number): void;
  protected abstract interrupt(): void;
  protected onStopRequested(): void {}

  async launch(spec: SessionSpec): Promise<SessionHandle> {
    if (this.state !== "new") throw new LaunchFailure("start-failed", "Runner is single-use.");
    this.state = "starting";
    const timeout = setTimeout(() => this.ready.resolve(false), this.readinessTimeout);
    try {
      this.starting = this.start(spec).then((pid) => { this.pid = pid; return pid; });
      const pid = await this.starting;
      if (!await this.ready.promise || !this.inState("starting")) {
        throw new LaunchFailure("start-failed", "Fixture exited or did not become ready.");
      }
      this.state = "running";
      return { pid };
    } catch (error) {
      try {
        await this.stop("kill");
      } catch (cleanupError) {
        throw new LaunchFailure(error instanceof LaunchFailure ? error.reason : "start-failed",
          "Fixture launch and cleanup failed.", new AggregateError([error, cleanupError]));
      }
      if (error instanceof LaunchFailure) throw error;
      throw new LaunchFailure("start-failed", "Could not start the fixture.", error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private inState(state: typeof this.state): boolean { return this.state === state; }

  protected data(chunk: Uint8Array): void {
    this.stream.push(chunk);
    if (this.state === "starting") {
      const text = this.readinessTail + Buffer.from(chunk).toString("ascii");
      if (text.includes("FIXTURE READY\r\n")) this.ready.resolve(true);
      this.readinessTail = text.slice(-32);
    }
  }

  protected async finish(info: ExitInfo): Promise<void> {
    if (this.state === "ended") return;
    this.state = "ended";
    this.ready.resolve(false);
    try {
      await this.starting?.catch(() => {});
      try {
        if (this.pid !== undefined) signalGroup(this.pid, "SIGKILL");
      } finally {
        await this.dispose();
      }
      this.exit.resolve(info);
    } catch (error) {
      this.exit.reject(error);
    } finally {
      this.stream.push(null);
    }
  }

  async write(text: string): Promise<WriteResult> {
    return this.sendIfRunning(text, false);
  }

  async key(name: PaneKey): Promise<WriteResult> {
    if (!isValidPaneKey(name)) return { status: "refused", reason: "invalid-key" };
    return this.sendIfRunning(name, true);
  }

  private sendIfRunning(value: string, named: boolean): WriteResult {
    if (this.state !== "running") return { status: "refused", reason: "not-running" };
    try {
      return this.send(value, named);
    } catch {
      return { status: "refused", reason: "write-failed" };
    }
  }

  output(): AsyncIterable<Uint8Array> { return this.stream; }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.state === "running") this.setSize(cols, rows);
  }

  async cancel(): Promise<void> {
    if (this.state === "running") this.interrupt();
  }

  async stop(mode: StopMode): Promise<ExitInfo> {
    if (this.state === "starting") {
      this.ready.resolve(false);
      await this.starting?.catch(() => {});
    }
    if (this.state === "ended" || this.state === "stopping") return this.exited();
    if (this.pid === undefined) {
      await this.finish({ code: null, signal: null });
      return this.exited();
    }
    this.state = "stopping";
    signalGroup(this.pid, mode === "kill" ? "SIGKILL" : "SIGTERM");
    this.onStopRequested();
    if (mode === "graceful") {
      const timer = new AbortController();
      try {
        if (await Promise.race([this.exited().then(() => false), delay(250, true, { signal: timer.signal })]) && this.state === "stopping") {
          signalGroup(this.pid, "SIGKILL");
        }
      } finally {
        timer.abort();
      }
    }
    return this.exited();
  }

  exited(): Promise<ExitInfo> { return this.exit.promise; }
}
