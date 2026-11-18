/**
 * The shell loader maps an agent's .kind marker to `pinned` and sorts it first.
 * The agent that sorts last is the assistant, so removing the mapping fails
 * this test. ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

vi.mock("~/lib/stores.server", () => ({
  makeStores: () => ({
    inbox: { listAgents: async () => ["alex", "scribe", "zed"], readBlocks: async () => [] },
    queue: {
      getHandled: async () => new Set<string>(),
      getDeadlines: async () => new Map<string, string>(),
    },
  }),
}));
vi.mock("~/lib/projects.server", () => ({ listCards: () => [] }));
vi.mock("~/lib/avatars.server", () => ({ avatarUrl: () => undefined }));

import { loader } from "~/routes/shell";

let root: string;
beforeEach(() => {
  root = mkdtempSync();
  process.env["AGENTS_ROOT"] = root;
  process.env["DATA_ROOT"] = root;
  process.env["MC_NOW"] = "2026-09-16T08:00:00Z";
  delete process.env["ACTIVITY_ROOT"];
});
afterEach(() => {
  delete process.env["AGENTS_ROOT"];
  delete process.env["DATA_ROOT"];
  delete process.env["MC_NOW"];
  rmSync(root);
});

const load = () =>
  loader({ params: {}, request: new Request("http://deck.test/"), context: {} } as never);

describe("shell loader pin", () => {
  it("pins the agent whose .kind is assistant and puts it first", async () => {
    fs.mkdirSync(path.join(root, "zed"));
    fs.writeFileSync(path.join(root, "zed", ".kind"), "assistant");
    const { agents } = await load();
    expect(agents.map((a) => a.name)).toEqual(["zed", "alex", "scribe"]);
    expect(agents[0]!.pinned).toBe(true);
  });

  it("keeps the inbox order when no .kind exists", async () => {
    const { agents } = await load();
    expect(agents.map((a) => a.name)).toEqual(["alex", "scribe", "zed"]);
    expect(agents.some((a) => a.pinned)).toBe(false);
  });
});
