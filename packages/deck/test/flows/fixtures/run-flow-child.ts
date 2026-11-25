/**
 * Real subprocess entrypoint for K1-K10 crash-matrix testing.
 * Runs the real Deck Flows Slice 1a runner (`runFlow`) inside an isolated OS process
 * so `FLOW_CRASH_POINT` triggers a genuine `SIGKILL` at each write-order boundary.
 */
import fs from "node:fs";
import { runFlow } from "../../../app/lib/flows/runner.server.js";

const [, , projectId, runId, dataRoot] = process.argv;
if (!projectId || !runId || !dataRoot) {
  console.error("Usage: run-flow-child.ts <projectId> <runId> <dataRoot>");
  process.exit(2);
}

runFlow(projectId, runId, { dataRoot })
  .then((res) => {
    process.stdout.write(JSON.stringify(res) + "\n");
    const holdFile = process.env["FLOW_HOLD_AFTER_DONE_FILE"];
    if (holdFile) {
      fs.writeFileSync(holdFile, "DONE", "utf8");
      // Stay alive briefly so parent can prove lock.release() freed flows.owner BEFORE process exit
      setTimeout(() => process.exit(0), 2000);
      return;
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
