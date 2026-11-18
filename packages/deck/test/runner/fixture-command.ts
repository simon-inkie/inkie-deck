import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSpec } from "./runner.js";

export function fixtureCommand(directory: string, spec: SessionSpec) {
  return {
    file: spec.scenario === "missing" ? join(directory, "missing-fixture") : process.execPath,
    args: [fileURLToPath(new URL("./fixture-agent.mjs", import.meta.url)), spec.scenario ?? "normal"],
    env: { HOME: directory, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C" },
  };
}
