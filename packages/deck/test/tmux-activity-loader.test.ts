/**
 * tmux-activity-loader.test.ts - the Team tab loader's activity half (TASK-691).
 *
 * Drives the EXPORTED loader, because the things worth pinning here are wiring
 * claims that neither the seam suite nor the render suite can see:
 *   - the gate is applied in the loader, so a gated-off instance does no fs
 *     work and ships no activity key at all;
 *   - the activity gate is INDEPENDENT of the tmux gate (the Q6 promise: an
 *     instance can get the panel by adding one env var, even with tmux off);
 *   - the loader's MC_NOW instant is the one the staleness decision uses, so
 *     the banner and the pills can never disagree about what time it is.
 *
 * MC_TMUX_SESSION is pointed at a guaranteed-missing session in every case (the
 * e2e/setup.mjs idiom), so no real agent pane is ever listed here. Nothing is
 * captured at all any more: the pane came off this page on 2026-07-31 and the
 * loader's only remaining tmux call is the window listing that feeds the
 * "no observation" rows.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loader } from "~/routes/tmux";
import { ACTIVITY_FILENAME } from "~/lib/activity.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const TOUCHED = [
  "ACTIVITY_ROOT",
  "MC_ACTIVITY_ENABLED",
  "MC_TMUX_ENABLED",
  "MC_TMUX_SESSION",
  "MC_NOW",
] as const;

const SAVED: Record<string, string | undefined> = {};
for (const key of TOUCHED) SAVED[key] = process.env[key];

const sandboxes: string[] = [];

/**
 * Clear every variable this suite reasons about BEFORE each case, not just
 * after. Restoring alone is not enough: any of these could be ambient in the
 * shell that runs vitest (MC_TMUX_ENABLED and MC_NOW both are, in some
 * configurations), and then a case would pass or fail depending on WHO ran it.
 */
beforeEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
  for (const key of TOUCHED) {
    const original = SAVED[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!);
});

const SWEPT = "2026-07-30T10:14:30Z";

function seedActivity(text?: string): string {
  const root = mkdtempSync();
  sandboxes.push(root);
  if (text !== undefined) {
    fs.writeFileSync(path.join(root, ACTIVITY_FILENAME), text, "utf8");
  }
  return root;
}

function liveFile(): string {
  return JSON.stringify({
    schema: 1,
    generator: "activity-sweep",
    swept: SWEPT,
    worktreeCandidates: 181,
    worktreeRootsSource: "builtin",
    notes: [],
    agents: {
      summit: {
        status: "done-for-now",
        signal: "idle-no-signal",
        evidence: "idle, no open cards",
        busy: false,
        idleMinutes: 2,
        worktree: {
          path: "/home/you/git-repos/inkie-summit",
          branch: "summit/task-599",
          confidence: "low",
          score: 96,
          reasons: ["branch-prefix=summit/"],
          alternatives: [],
          pinned: false,
          guess: null,
        },
        recent: [],
        updated: SWEPT,
      },
    },
  });
}

/** Run the loader with a session name that cannot exist (no live pane touched). */
async function runLoader() {
  process.env["MC_TMUX_SESSION"] = "mc-test-missing";
  return loader();
}

// ---------------------------------------------------------------------------

describe("tmux loader - the activity gate", () => {
  it("ships activity: null when no ACTIVITY_ROOT is configured", async () => {
    delete process.env["ACTIVITY_ROOT"];
    const data = await runLoader();
    expect(data.activity).toBeNull();
    // Nothing else is left to ship: with the pane gone (2026-07-31) the page
    // is the panel, so an ungated instance loads an empty payload, not a
    // half-populated terminal one.
    expect(data.avatars).toEqual({});
  });

  it("ships activity: null when the kill switch is set, even with a root", async () => {
    process.env["ACTIVITY_ROOT"] = seedActivity(liveFile());
    process.env["MC_ACTIVITY_ENABLED"] = "0";
    process.env["MC_NOW"] = "2026-07-30T10:15:00Z";
    const data = await runLoader();
    expect(data.activity).toBeNull();
  });

  it("reads the file when the root IS configured", async () => {
    process.env["ACTIVITY_ROOT"] = seedActivity(liveFile());
    process.env["MC_NOW"] = "2026-07-30T10:15:00Z";
    const data = await runLoader();
    expect(data.activity).not.toBeNull();
    expect(data.activity!.state).toBe("live");
    if (data.activity!.state !== "live") return;
    expect(data.activity!.agents.map((a) => a.agent)).toEqual(["summit"]);
    expect(data.activity!.sweptAt).toBe(SWEPT);
    expect(data.now).toBe("2026-07-30T10:15:00.000Z");
  });
});

describe("tmux loader - activity is gated independently of tmux (decision Q6)", () => {
  it("a tmux-DISABLED instance with a root still gets the panel data", async () => {
    process.env["MC_TMUX_ENABLED"] = "0";
    process.env["ACTIVITY_ROOT"] = seedActivity(liveFile());
    process.env["MC_NOW"] = "2026-07-30T10:15:00Z";
    const data = await runLoader();
    // The tmux surface is off, and the activity panel is NOT collateral
    // damage. Without this, "adding another instance is a config change" would
    // be false for Robin, whose instance has MC_TMUX_ENABLED off.
    expect(data.activity).not.toBeNull();
    expect(data.activity!.state).toBe("live");
    // The window listing (the only tmux call left after the pane came out) is
    // still gated: an instance with tmux off must fork nothing, and its rows
    // come from the file alone.
    expect(data.activity!.agents.map((a) => a.agent)).toEqual(["summit"]);
  });

  it("a tmux-disabled instance WITHOUT a root gets nothing, and does not break", async () => {
    process.env["MC_TMUX_ENABLED"] = "0";
    delete process.env["ACTIVITY_ROOT"];
    const data = await runLoader();
    expect(data.activity).toBeNull();
  });
});

describe("tmux loader - degrades honestly (the state of the world today)", () => {
  it("missing state file: offline/missing, and the tab loads fine", async () => {
    process.env["ACTIVITY_ROOT"] = seedActivity(); // no file written
    const data = await runLoader();
    expect(data.activity?.state).toBe("offline");
    if (data.activity?.state !== "offline") return;
    expect(data.activity.reason).toBe("missing");
    expect(data.activity.agents).toEqual([]);
  });

  it("corrupt state file: offline/corrupt, never a thrown loader", async () => {
    process.env["ACTIVITY_ROOT"] = seedActivity("{ half a fi");
    await expect(runLoader()).resolves.toBeDefined();
    const data = await runLoader();
    expect(data.activity?.state).toBe("offline");
    if (data.activity?.state !== "offline") return;
    expect(data.activity.reason).toBe("corrupt");
  });

  it("MC_NOW drives the staleness verdict through the loader, not just the seam", async () => {
    process.env["ACTIVITY_ROOT"] = seedActivity(liveFile());
    // Three hours after the sweep: the same file that is live above.
    process.env["MC_NOW"] = "2026-07-30T13:14:30Z";
    const data = await runLoader();
    expect(data.activity?.state).toBe("offline");
    if (data.activity?.state !== "offline") return;
    expect(data.activity.reason).toBe("stale");
    expect(data.activity.sweptAt).toBe(SWEPT);
    // The last-known rows reach the component, which dims them (2026-07-31).
    expect(data.activity.agents.map((a) => a.agent)).toEqual(["summit"]);
    // The avatar map is keyed off those ROWS now, not off the (empty here)
    // window list. Whether summit HAS an avatar file is avatarUrl's business
    // and depends on the box, so the claim under test is the narrow one: no
    // key can appear that is not a rendered row.
    expect(Object.keys(data.avatars).every((k) => k === "summit")).toBe(true);
  });

  it("a root pointing at a non-existent directory is offline, not an exception", async () => {
    process.env["ACTIVITY_ROOT"] = path.join(seedActivity(), "nope", "deeper");
    const data = await runLoader();
    expect(data.activity?.state).toBe("offline");
  });
});
