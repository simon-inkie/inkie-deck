import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { PtyRunner } from "./pty-runner.js";
import type { Runner } from "./runner.js";
import { TmuxRunner } from "./tmux-runner.js";

export function fixtureRegistry(directory: string): (kind: Runner["kind"]) => Runner {
  const canonical = realpathSync(directory);
  const fromTemp = relative(realpathSync(tmpdir()), canonical);
  if (!fromTemp || fromTemp === ".." || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp) || !statSync(canonical).isDirectory()) {
    throw new Error("Fixture registry requires a directory strictly inside the temporary directory.");
  }
  return (kind) => {
    if (kind !== "pty" && kind !== "tmux") throw new Error("Unknown fixture runner.");
    const home = mkdtempSync(join(canonical, "s-"));
    return kind === "pty" ? new PtyRunner(home) : new TmuxRunner(home);
  };
}
