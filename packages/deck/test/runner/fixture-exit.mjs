import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

const [statusFile, ...command] = process.argv.slice(2);
const fixture = spawn("/usr/bin/env", command, { stdio: "inherit" });
fixture.once("exit", (code, signal) => {
  const signalNumber = signal ? constants.signals[signal] : 0;
  const pending = `${statusFile}.tmp`;
  writeFileSync(pending, `${process.pid} ${code ?? 0} ${signalNumber}\n`);
  renameSync(pending, statusFile);
  process.exitCode = code ?? 128 + signalNumber;
});
