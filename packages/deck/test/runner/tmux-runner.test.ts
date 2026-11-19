import { ChildProcess, type ExecFileException } from "node:child_process";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { TmuxRunner } from "./tmux-runner.js";

const panePid = 12345;
let runnerToStop: TmuxRunner | undefined;

function fakeChild(pid: number) {
  const child = Object.assign(new ChildProcess(), { pid, stdin: new PassThrough(), stdout: new PassThrough() });
  const close = () => {
    Object.assign(child, { exitCode: 0 });
    child.stdin.end();
    child.stdout.end();
    child.stdout.once("end", () => child.emit("close", 0, null));
    child.stdout.resume();
  };
  const kill = vi.spyOn(child, "kill").mockImplementation(() => { close(); return true; });
  return { child, close, kill };
}

function fixture(status: () => string | Error, {
  wedgedShutdown = false, ready = true, paneDead = "0", viewport = ">\n",
} = {}) {
  const server = fakeChild(12346);
  const control = fakeChild(12347);
  const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
  function expectPrivateInvocation(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
    expect(file).toBe("tmux");
    expect(args.slice(1, 3)).toEqual(["-S", "/unused/tmux.sock"]);
    expect(options.env).toEqual({ HOME: "/unused", PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C" });
  }
  const execFile = vi.fn((file: string, args: string[], options: { env: NodeJS.ProcessEnv },
    callback: (error: ExecFileException | null, stdout: string) => void) => {
    expectPrivateInvocation(file, args, options);
    expect(args[0]).toBe("-N");
    const response = args.at(-1) === "#{pane_pid}" ? String(panePid)
      : args[3] === "display-message" ? status() : "";
    queueMicrotask(() => {
      if (args[3] === "kill-server") {
        if (wedgedShutdown) return;
        server.close();
        control.close();
      }
      if (response instanceof Error) callback(response, "");
      else callback(null, response);
    });
  });
  const execFileSync = vi.fn((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    expectPrivateInvocation(file, args, options);
    expect(args[0]).toBe("-N");
    if (args.at(-1) === "#{pane_dead}") return paneDead;
    if (args[3] === "capture-pane") return viewport;
    throw new Error("Unexpected synchronous tmux command");
  });
  const spawn = vi.fn((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    expectPrivateInvocation(file, args, options);
    if (args[0] === "-D") return server.child;
    if (ready) queueMicrotask(() => control.child.stdout.write("%output %0 FIXTURE READY\\015\\012\n"));
    return control.child;
  });
  control.child.stdin.on("data", (chunk: Buffer) => {
    const marker = chunk.toString().trim().split(" ").at(-1);
    setTimeout(() => {
      if (control.child.exitCode === null) {
        control.child.stdout.write(`%output %0 FIXTURE END\\015\\012\n${marker}\n`);
      }
    }, 20);
  });
  const runner = runnerToStop = new TmuxRunner("/unused", { execFile, execFileSync, spawn } as unknown as
    NonNullable<ConstructorParameters<typeof TmuxRunner>[1]>);
  return { runner, server, control, groupKill, execFileSync };
}

afterEach(async () => {
  try {
    await runnerToStop?.stop("kill");
  } finally {
    runnerToStop = undefined;
    vi.restoreAllMocks();
  }
});

it("retries a failed probe and waits for a late exit status before closing output", async () => {
  const status = vi.fn().mockReturnValueOnce(new Error("command timed out"))
    .mockReturnValueOnce("1  \n").mockReturnValueOnce("1  \n").mockReturnValue("1 23 \n");
  const { runner, server, control } = fixture(status, { ready: false });
  const output = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of runner.output()) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  })();

  await expect(runner.launch({ scenario: "failed" })).rejects.toMatchObject({ reason: "start-failed" });
  await expect(runner.exited()).resolves.toEqual({ code: 23, signal: null });
  await expect(output).resolves.toBe("FIXTURE END\r\n");
  expect(status).toHaveBeenCalledTimes(4);
  expect(server.child.exitCode).toBe(0);
  expect(control.child.exitCode).toBe(0);
});

it.each([
  { pending: "running", response: "0  \n", delayMs: 3500 },
  { pending: "dead without status", response: "1  \n", delayMs: 1500 },
  { pending: "unreachable", response: new Error("command timed out"), delayMs: 1500 },
])("keeps waiting for natural exit while the pane is $pending", async ({ response, delayMs }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let status = response;
    const { runner, groupKill } = fixture(() => status);
    await runner.launch({});
    const reported = vi.fn();
    void runner.exited().then(reported, reported);

    await vi.advanceTimersByTimeAsync(delayMs);
    expect(reported).not.toHaveBeenCalled();
    expect(groupKill).not.toHaveBeenCalled();

    status = "1 0 \n";
    await vi.advanceTimersByTimeAsync(100);
    expect(reported).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null });
    expect(groupKill).toHaveBeenCalledWith(-panePid, "SIGKILL");
  } finally {
    vi.useRealTimers();
  }
});

it("settles with unknown status after stopping a pane that never reports its status", async () => {
  const { runner, groupKill } = fixture(() => "1  \n");
  await runner.launch({});
  await expect(runner.stop("kill")).resolves.toEqual({ code: null, signal: null });
  expect(groupKill).toHaveBeenCalledWith(-panePid, "SIGKILL");
});

it("reports the kill signal and refuses writes immediately while stopping", async () => {
  let status = "0  \n";
  const { runner, groupKill, execFileSync } = fixture(() => status);
  await runner.launch({});
  groupKill.mockImplementation(() => { status = "1  KILL\n"; return true; });
  const stopped = runner.stop("kill");
  await expect(runner.write("no input")).resolves.toEqual({ status: "refused", reason: "not-running" });
  await expect(stopped).resolves.toEqual({ code: null, signal: constants.signals.SIGKILL });
  expect(groupKill).toHaveBeenCalledWith(-panePid, "SIGKILL");
  expect(execFileSync).not.toHaveBeenCalled();
});

it.each([
  { paneDead: "1", viewport: ">\n", reason: "not-running", inspections: ["display-message", "display-message"] },
  { paneDead: "0", viewport: "fixture@terminal:~$\n", reason: "unsafe-pane",
    inspections: ["display-message", "capture-pane", "display-message", "capture-pane"] },
])("refuses text and named keys with $reason before the exit poll", async ({ paneDead, viewport, reason, inspections }) => {
  let status = "0  \n";
  const { runner, groupKill, execFileSync } = fixture(() => status, { paneDead, viewport });
  await runner.launch({});
  groupKill.mockImplementation(() => { status = "1  KILL\n"; return true; });
  await expect(runner.write("must not reach a shell")).resolves.toEqual({ status: "refused", reason });
  await expect(runner.key("Enter")).resolves.toEqual({ status: "refused", reason });
  expect(execFileSync.mock.calls.map(([, args]) => args[3])).toEqual(inspections);
});

it("forces both tmux processes down if the pane never reports death and shutdown stalls", { timeout: 7000 }, async () => {
  const { runner, server, control, groupKill } = fixture(() => "0  \n", { wedgedShutdown: true });
  await runner.launch({});
  await expect(runner.stop("kill")).resolves.toEqual({ code: null, signal: null });
  expect(groupKill).toHaveBeenCalledWith(-panePid, "SIGKILL");
  expect(server.kill).toHaveBeenCalledWith("SIGKILL");
  expect(control.kill).toHaveBeenCalledWith("SIGKILL");
});
