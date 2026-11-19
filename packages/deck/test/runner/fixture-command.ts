import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSpec } from "../../app/lib/runner/runner.js";

export interface FixtureSpec {
  scenario?: "normal" | "slow" | "failed" | "missing" | "plain" | "silent" | "registry";
  cols?: number;
  rows?: number;
}

export function fixtureEnvironment(directory: string) {
  return { HOME: directory, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C" };
}

export function fixtureCommand(directory: string, spec: FixtureSpec): SessionSpec {
  const env = fixtureEnvironment(directory);
  const plain = spec.scenario === "plain";
  return {
    command: spec.scenario === "missing" ? join(directory, "missing-fixture")
      : plain ? basename(process.execPath) : process.execPath,
    args: [fileURLToPath(new URL("./fixture-agent.mjs", import.meta.url)), spec.scenario ?? "normal"],
    cwd: directory,
    env: plain ? { ...env, PATH: dirname(process.execPath) } : env,
    cols: spec.cols,
    rows: spec.rows,
  };
}
