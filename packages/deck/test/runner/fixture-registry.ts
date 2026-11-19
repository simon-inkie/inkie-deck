import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { PtyRunner } from "../../app/lib/runner/pty-runner.server.js";
import type { Runner, SessionHandle } from "../../app/lib/runner/runner.js";
import { fixtureCommand, type FixtureSpec } from "./fixture-command.js";
import { TmuxRunner } from "./tmux-runner.js";

export interface FixtureRunner extends Omit<Runner, "launch"> {
  launch(spec: FixtureSpec): Promise<SessionHandle>;
}

export function fixtureRegistry(directory: string): (kind: Runner["kind"]) => FixtureRunner {
  const canonical = realpathSync(directory);
  const fromTemp = relative(realpathSync(tmpdir()), canonical);
  if (!fromTemp || fromTemp === ".." || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp) || !statSync(canonical).isDirectory()) {
    throw new Error("Fixture registry requires a directory strictly inside the temporary directory.");
  }
  return (kind) => {
    if (kind !== "pty" && kind !== "tmux") throw new Error("Unknown fixture runner.");
    const home = mkdtempSync(join(canonical, "s-"));
    const runner = kind === "pty" ? new PtyRunner() : new TmuxRunner(home);
    return {
      kind: runner.kind,
      caps: runner.caps,
      launch: (spec) => runner.launch(fixtureCommand(home, spec)),
      write: runner.write.bind(runner),
      key: runner.key.bind(runner),
      output: runner.output.bind(runner),
      resize: runner.resize.bind(runner),
      cancel: runner.cancel.bind(runner),
      stop: runner.stop.bind(runner),
      exited: runner.exited.bind(runner),
    };
  };
}
