import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunnerRegistry } from "../../app/lib/runner/registry.server.ts";
import { fixtureCommand } from "./fixture-command.ts";

const agent = "fixture-agent";
const home = join(process.env.AGENTS_HOME, agent);
const registry = new RunnerRegistry(process.env, {
  launchSpec: ({ cwd, env }) => ({ ...fixtureCommand(cwd, {}), env }),
  listWindows: () => [],
});

let fixtureProcesses;
Server.prototype.listen = function () {
  process.send(fixtureProcesses);
  return this;
};

export const publicPath = "/";
export const assetsBuildDirectory = home;
export const routes = {};
export const entry = { module: { runnerLifecycle: {
  async recover() {
    await registry.recover();
    await registry.start(agent);
    assert.deepEqual(await registry.write(agent, "descendant"), { status: "written" });
    assert.deepEqual(await registry.key(agent, "Enter"), { status: "written" });
    const { childPid } = JSON.parse(readFileSync(join(home, ".runner.lock"), "utf8"));
    for (let attempt = 0; attempt < 100; attempt++) {
      const marker = readdirSync(home).find((name) => /^descendant-\d+$/.test(name));
      if (marker) {
        fixtureProcesses = { childPid, descendant: Number(marker.slice("descendant-".length)) };
        return;
      }
      await delay(20);
    }
    await registry.shutdown();
    throw new Error("The fixture descendant did not start.");
  },
  shutdown: () => registry.shutdown(),
} } };
