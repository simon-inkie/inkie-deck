import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRegistry } from "./fixture-registry.js";
import type { Runner } from "./runner.js";

function groupMembers(group: number): number[] {
  return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , processGroup] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(processGroup) === group && state !== "Z" ? [Number(pid)] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  });
}

describe.runIf(process.platform === "linux").each(["tmux", "pty"] as const)("%s runner contract", (kind) => {
  let directory: string;
  let runner: Runner;
  let transcript: string;
  let drained: Promise<void>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "r-"));
    runner = fixtureRegistry(directory)(kind);
    transcript = "";
    drained = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of runner.output()) transcript += decoder.decode(chunk, { stream: true });
      transcript += decoder.decode();
    })();
  });

  afterEach(async () => {
    try {
      await runner.stop("kill");
      await drained;
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  async function waitFor(text: string) {
    await vi.waitFor(() => expect(transcript).toContain(text), { timeout: 1500 });
  }

  async function submit(text: string) {
    expect(await runner.write(text)).toEqual({ status: "written" });
    expect(await runner.key("Enter")).toEqual({ status: "written" });
  }

  it("waits for readiness and streams delayed bytes in order through exit", async () => {
    expect(runner.caps).toEqual({ terminalAttach: false, deliveryAck: false, stateEvents: false });
    const launched = runner.launch({ scenario: "slow" });
    expect(await runner.write("not ready")).toEqual({ status: "refused", reason: "not-running" });
    await launched;
    await waitFor("THIRD frame");
    await submit("exit");
    expect(await runner.exited()).toEqual({ code: 0, signal: null });
    await drained;
    expect(transcript).toBe("\x1b[?2004hFIXTURE READY\r\n>\r\nFIRST \\ frame\r\n" +
      "SECOND \u00a3 frame\r\nTHIRD frame\r\nfixture@terminal:~$\r\nFIXTURE END\r\n");
  });

  it.each(["failed", "missing"] as const)("reports a %s launch without accepting input", async (scenario) => {
    await expect(runner.launch({ scenario })).rejects.toMatchObject({ name: "LaunchFailure", reason: "start-failed" });
    const { code } = await runner.exited();
    if (scenario === "failed") expect(code).toBe(23);
    else expect(code).toBeGreaterThan(0);
    expect(await runner.key("Enter")).toEqual({ status: "refused", reason: "not-running" });
  });

  it("resizes the terminal and interrupts a running task", async () => {
    await runner.launch({});
    await runner.resize(96, 32);
    await waitFor("SIZE 96x32");
    await submit("work");
    await waitFor("TASK STARTED");
    await runner.cancel();
    await waitFor("TASK CANCELLED");
    await submit("confirm");
    await waitFor("CONFIRM? [Enter/Escape]");
    expect(await runner.key("Escape")).toEqual({ status: "written" });
    await waitFor("DECLINED");
    await submit(`\x1b[200~${"paste ".repeat(20)}\x1b[201~`);
    await waitFor("[long paste]");
    await submit("environment");
    await waitFor(kind === "pty" ? "ENV HOME,LANG,PATH,PWD,TERM\r\n" : "ENV HOME,LANG,PATH,TERM\r\n");
    expect(transcript).not.toContain("TASK FINISHED");
  });

  it.each(["graceful", "kill", "natural"] as const)("cleans the fixture process group on %s exit", async (mode) => {
    const { pid } = await runner.launch({});
    await submit("descendant");
    await vi.waitFor(() => expect(transcript).toMatch(/DESCENDANT \d+\r\n/));
    const descendant = Number(/DESCENDANT (\d+)\r\n/.exec(transcript)?.[1]);
    expect(groupMembers(pid)).toEqual(expect.arrayContaining([pid, descendant]));

    if (mode === "natural") await submit("exit");
    else await runner.stop(mode);
    await runner.exited();
    const refused = { status: "refused", reason: "not-running" };
    expect(await runner.write("must not reach a shell")).toEqual(refused);
    expect(await runner.key("Enter")).toEqual(refused);
    await drained;
    if (mode === "natural") expect(transcript).toContain("fixture@terminal:~$");
    expect(transcript).not.toContain("must not reach a shell");
    await vi.waitFor(() => expect(groupMembers(pid)).toEqual([]));
  });
});

it.runIf(process.platform === "linux")("rejects the temp root, a non-temp path and a symlink escape", () => {
  const directory = mkdtempSync(join(tmpdir(), "r-"));
  try {
    const outside = parse(directory).root;
    const escape = join(directory, "escape");
    symlinkSync(outside, escape, "junction");
    for (const path of [tmpdir(), outside, escape]) {
      expect(() => fixtureRegistry(path)).toThrow(/strictly inside the temporary directory/);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it.runIf(process.platform === "linux")("loads node-pty only on launch and reports a missing dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "r-"));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import Module from "node:module";
      const load = Module._load;
      let attempts = 0;
      Module._load = function (name, ...args) {
        if (name === "node-pty") {
          attempts++;
          throw Object.assign(new Error("node-pty is missing"), { code: "MODULE_NOT_FOUND" });
        }
        return load.call(this, name, ...args);
      };
      const { fixtureRegistry } = await import("./test/runner/fixture-registry.ts");
      const runner = fixtureRegistry(process.argv[1])("pty");
      assert.equal(attempts, 0);
      await assert.rejects(runner.launch({}), { reason: "unavailable", message: /node-pty is missing/ });
      assert.equal(attempts, 1);
    `, directory], { stdio: ["ignore", "ignore", "pipe"], timeout: 4000 });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Missing-dependency probe exited with ${signal ?? code}: ${stderr}`));
      });
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
