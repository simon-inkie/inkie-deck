/**
 * test/activity.test.ts - the activity seam.
 *
 * WHAT THIS SUITE IS WEIGHTED TOWARDS, AND WHY. The producer sweep is not on
 * cron yet, so for the whole life of this MR - and for however long after it
 * ships until the operator wires the job - there IS no activity.json. The
 * missing/stale/corrupt paths are not edge cases here, they are the only paths
 * that run in production today, so they get the same care as the happy path
 * (and more cases). The one invariant above all others: readActivity NEVER
 * throws, because the Team tab must survive a sweep that has never run, has
 * died, or has written half a file.
 *
 * Fixtures are tmpdir-only, and every clock is injected (MC_NOW pattern, same
 * as briefs.test.ts) so the staleness boundary is deterministic in CI.
 *
 * Writes only to os.tmpdir(). No repo files are mutated.
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVITY_FILENAME,
  ACTIVITY_STALE_AFTER_MS,
  activityFilePath,
  readActivity,
  resolveActivityRoot,
} from "~/lib/activity.server";
import {
  NOT_SWEPT_SIGNAL,
  SUPPORTED_ACTIVITY_SCHEMA,
  activityRows,
  confidenceLabel,
  countStatuses,
  parseActivityDocument,
  statusLabel,
  worktreeName,
  type AgentActivity,
} from "~/lib/activity.shared";
import { activityEnabled } from "~/lib/instance.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-30T10:15:00Z");
const SWEPT = "2026-07-30T10:14:30Z";

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync();
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!);
});

/**
 * A live record, copied from the sweep SPEC's verbatim example (summit) plus
 * the pinned and no-candidate shapes taken from the producer source, so the
 * types here are pinned against what the file really contains rather than a
 * paraphrase of it.
 */
function liveDocument(): Record<string, unknown> {
  return {
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
        evidence: "idle since 2026-07-30T10:12:14Z, no open cards and no unread outbound",
        busy: false,
        idleMinutes: 0,
        paneHash: "0a28d4cd06e061da",
        paneUnchangedSince: "2026-07-30T10:12:14Z",
        paneUnchangedSinceEpoch: 1785406334,
        worktree: {
          path: "/home/you/git-repos/inkie-summit",
          branch: "summit/task-599-video-poster-backfill",
          confidence: "low",
          score: 96,
          reasons: ["branch-prefix=summit/", "worktree-name=inkie-summit"],
          alternatives: [
            {
              path: "/home/you/git-repos/inkie-summit3",
              branch: "summit/task-663-gemini-flash-pricing",
              score: 95,
            },
          ],
          pinned: false,
          guess: null,
        },
        recent: [
          {
            key: "inbox:alex.md:2026-07-30T09:58:58Z",
            at: "2026-07-30T09:58:58Z",
            kind: "inbox",
            label: "Both done. MC restarted earlier (confirmed).",
            ref: "alex.md",
          },
        ],
        updated: SWEPT,
      },
      sprout: {
        status: "needs-you",
        signal: "open-card",
        evidence: "decision card d-91 open since 09:02, 14 open in total",
        busy: false,
        idleMinutes: 41,
        worktree: {
          path: "/home/you/git-repos/inkie-sprout",
          branch: "sprout/task-702-brief-copy",
          confidence: "high",
          score: 92,
          reasons: ["branch-prefix=sprout/", "worktree-name=inkie-sprout", "active<24h"],
          alternatives: [],
          pinned: false,
          guess: null,
        },
        recent: [],
        updated: SWEPT,
      },
      quill: {
        status: "working",
        signal: "pane-busy",
        evidence: "pane busy, turn in flight",
        busy: true,
        idleMinutes: 0,
        worktree: {
          path: "/home/you/git-repos/inkie-quill2",
          branch: "quill/task-691-panel",
          confidence: "pinned",
          score: null,
          pinned: true,
          pinnedBy: "alex",
          pinnedAt: "2026-07-29T18:00:00Z",
          reasons: ["pinned override"],
          alternatives: [],
          guess: {
            path: "/home/you/git-repos/inkie-quill",
            branch: "quill/something-else",
            confidence: "low",
            score: 61,
            reasons: ["worktree-name=inkie-quill"],
            alternatives: [],
          },
        },
        recent: [
          {
            key: "commit:abc1234",
            at: "2026-07-30T10:01:00Z",
            kind: "commit",
            label: "fix(mc): batch ownership travels with the batch",
            ref: "inkie-quill2@abc1234",
          },
        ],
        updated: SWEPT,
      },
      fern: {
        status: "stuck",
        signal: "stuck-shape",
        evidence: "pane tail matches a permission dialog literal",
        busy: false,
        idleMinutes: 12,
        worktree: {
          path: null,
          branch: null,
          confidence: "none",
          score: 0,
          reasons: ["no candidate worktree scored above zero"],
          alternatives: [],
          pinned: false,
          guess: null,
        },
        recent: [],
        updated: SWEPT,
      },
    },
  };
}

/** Seed an ACTIVITY_ROOT holding the given file text (or no file at all). */
function seedRoot(text?: string): string {
  const root = sandbox();
  if (text !== undefined) {
    fs.writeFileSync(path.join(root, ACTIVITY_FILENAME), text, "utf8");
  }
  return root;
}

function env(root?: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...(root === undefined ? {} : { ACTIVITY_ROOT: root }), ...extra };
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

describe("resolveActivityRoot", () => {
  it("is undefined when unset, blank, or whitespace", () => {
    expect(resolveActivityRoot({})).toBeUndefined();
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "" })).toBeUndefined();
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "   " })).toBeUndefined();
  });

  it("is undefined for a relative path (a relative root is a silently wrong dir)", () => {
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "data/activity" })).toBeUndefined();
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "./activity" })).toBeUndefined();
  });

  it("expands a leading tilde (resolveAgentsRoot's idiom)", () => {
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "~" })).toBe(os.homedir());
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "~/.the-vault/activity" })).toBe(
      path.join(os.homedir(), ".the-vault/activity")
    );
  });

  it("passes an absolute path through, and names the one file it reads", () => {
    expect(resolveActivityRoot({ ACTIVITY_ROOT: "/srv/activity" })).toBe("/srv/activity");
    expect(activityFilePath({ ACTIVITY_ROOT: "/srv/activity" })).toBe(
      "/srv/activity/activity.json"
    );
    expect(activityFilePath({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The instance gate
// ---------------------------------------------------------------------------

describe("activityEnabled (the operator-only gate)", () => {
  it("is OFF when no ACTIVITY_ROOT is configured (a second user's instance)", () => {
    expect(activityEnabled({})).toBe(false);
    expect(activityEnabled({ MC_USER: "robin" })).toBe(false);
  });

  it("is ON for any instance whose env names an absolute ACTIVITY_ROOT", () => {
    expect(activityEnabled({ ACTIVITY_ROOT: "/srv/activity" })).toBe(true);
    // The promise the gate exists to keep: adding another instance later is a
    // config change, not a rewrite. A second user with a root set gets the panel.
    expect(activityEnabled({ MC_USER: "robin", ACTIVITY_ROOT: "/srv/activity" })).toBe(true);
  });

  it("is OFF for a relative root (no half-configured instance)", () => {
    expect(activityEnabled({ ACTIVITY_ROOT: "activity" })).toBe(false);
  });

  it("MC_ACTIVITY_ENABLED=0/false is an explicit kill switch over a set root", () => {
    expect(activityEnabled({ ACTIVITY_ROOT: "/srv/activity", MC_ACTIVITY_ENABLED: "0" })).toBe(false);
    expect(activityEnabled({ ACTIVITY_ROOT: "/srv/activity", MC_ACTIVITY_ENABLED: "false" })).toBe(false);
    expect(activityEnabled({ ACTIVITY_ROOT: "/srv/activity", MC_ACTIVITY_ENABLED: "FALSE" })).toBe(false);
  });

  it("MC_ACTIVITY_ENABLED=1 does NOT conjure a panel without a root to read", () => {
    expect(activityEnabled({ MC_ACTIVITY_ENABLED: "1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseActivityDocument - the corrupt matrix
// ---------------------------------------------------------------------------

describe("parseActivityDocument - rejections", () => {
  it("an empty file is corrupt, and says so in those words", () => {
    const res = parseActivityDocument("");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("corrupt");
      expect(res.detail).toContain("empty");
    }
  });

  it("a truncated / torn write is corrupt, and carries the parser's own error", () => {
    // A half-written file is a live possibility, not a theory: the producer
    // replaces activity.json with `mv` out of /tmp, which is not atomic when
    // /tmp is a different filesystem.
    const half = JSON.stringify(liveDocument()).slice(0, 400);
    const res = parseActivityDocument(half);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("corrupt");
      expect(res.detail).toContain("not valid JSON");
    }
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["[]", '"hello"', "42", "null"]) {
      const res = parseActivityDocument(text);
      expect(res.ok, text).toBe(false);
      if (!res.ok) expect(res.reason).toBe("corrupt");
    }
  });

  it("an unrecognised schema version is refused, naming BOTH versions", () => {
    const doc = { ...liveDocument(), schema: 2 };
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unsupported-schema");
      expect(res.detail).toContain("2");
      expect(res.detail).toContain(String(SUPPORTED_ACTIVITY_SCHEMA));
    }
  });

  it("an absent schema field is refused (and says absent, not 'undefined')", () => {
    const doc: Record<string, unknown> = liveDocument();
    delete doc["schema"];
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unsupported-schema");
      expect(res.detail).toContain("absent");
    }
  });

  it("a document with no `swept` is corrupt: freshness cannot be judged", () => {
    const doc: Record<string, unknown> = liveDocument();
    delete doc["swept"];
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("corrupt");
      expect(res.detail).toContain("swept");
    }
  });
});

describe("parseActivityDocument - the real record", () => {
  it("reads the sweep's own documented example, field for field", () => {
    const res = parseActivityDocument(JSON.stringify(liveDocument()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { doc } = res;
    expect(doc.schema).toBe(1);
    expect(doc.generator).toBe("activity-sweep");
    expect(doc.swept).toBe(SWEPT);
    expect(doc.worktreeCandidates).toBe(181);
    expect(doc.worktreeRootsSource).toBe("builtin");

    // Agents keep the file's order (the sweep's tmux window order).
    expect(doc.agents.map((a) => a.agent)).toEqual(["summit", "sprout", "quill", "fern"]);

    const summit = doc.agents[0]!;
    expect(summit.status).toBe("done-for-now");
    expect(summit.signal).toBe("idle-no-signal");
    expect(summit.evidence).toContain("no open cards");
    expect(summit.busy).toBe(false);
    expect(summit.idleMinutes).toBe(0);
    expect(summit.worktree?.path).toBe("/home/you/git-repos/inkie-summit");
    expect(summit.worktree?.branch).toBe("summit/task-599-video-poster-backfill");
    expect(summit.worktree?.confidence).toBe("low");
    expect(summit.worktree?.score).toBe(96);
    expect(summit.worktree?.alternatives).toEqual([
      {
        path: "/home/you/git-repos/inkie-summit3",
        branch: "summit/task-663-gemini-flash-pricing",
        score: 95,
      },
    ]);
    expect(summit.recent[0]?.kind).toBe("inbox");
    expect(summit.recent[0]?.label).toContain("Both done");
  });

  it("carries the pinned shape, including score:null and the scorer's guess", () => {
    const res = parseActivityDocument(JSON.stringify(liveDocument()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const quill = res.doc.agents.find((a) => a.agent === "quill")!;
    // "pinned" is a FOURTH confidence value the producer emits; the schema
    // prose lists only high/medium/low/none, so this is pinned against source.
    expect(quill.worktree?.confidence).toBe("pinned");
    expect(quill.worktree?.pinned).toBe(true);
    expect(quill.worktree?.score).toBeNull();
    expect(quill.worktree?.pinnedBy).toBe("alex");
    expect(quill.worktree?.guess?.path).toBe("/home/you/git-repos/inkie-quill");
  });

  it("carries the no-candidate shape as a null path with confidence none", () => {
    const res = parseActivityDocument(JSON.stringify(liveDocument()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fern = res.doc.agents.find((a) => a.agent === "fern")!;
    expect(fern.worktree?.path).toBeNull();
    expect(fern.worktree?.confidence).toBe("none");
    expect(fern.worktree?.reasons[0]).toContain("no candidate");
  });
});

describe("parseActivityDocument - per-field tolerance", () => {
  const base = (agent: Record<string, unknown>): string =>
    JSON.stringify({
      schema: 1,
      generator: "activity-sweep",
      swept: SWEPT,
      notes: [],
      agents: { sprout: agent },
    });

  function onlyAgent(text: string): AgentActivity {
    const res = parseActivityDocument(text);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res.doc.agents[0]!;
  }

  it("an unrecognised status degrades to unknown, never to a wrong verdict", () => {
    const a = onlyAgent(base({ status: "vibing", evidence: "e" }));
    expect(a.status).toBe("unknown");
  });

  it("an unrecognised confidence degrades to none", () => {
    const a = onlyAgent(base({ status: "working", worktree: { path: "/x", confidence: "certain" } }));
    expect(a.worktree?.confidence).toBe("none");
  });

  it("a malformed worktree object degrades to null, keeping the rest of the row", () => {
    const a = onlyAgent(base({ status: "working", evidence: "still here", worktree: "nope" }));
    expect(a.worktree).toBeNull();
    expect(a.status).toBe("working");
    expect(a.evidence).toBe("still here");
  });

  it("drops alternatives with no path and recent entries with no label", () => {
    const a = onlyAgent(
      base({
        status: "working",
        worktree: {
          path: "/x",
          confidence: "high",
          alternatives: [{ branch: "b", score: 1 }, { path: "/y", score: 2 }, 7],
        },
        recent: [{ at: "t", kind: "commit" }, { label: "kept", at: "t2" }, null],
      })
    );
    expect(a.worktree?.alternatives.map((x) => x.path)).toEqual(["/y"]);
    expect(a.recent.map((r) => r.label)).toEqual(["kept"]);
  });

  it("a non-object agent value is skipped without losing its siblings", () => {
    const res = parseActivityDocument(
      JSON.stringify({
        schema: 1,
        swept: SWEPT,
        agents: { broken: "not-an-object", sprout: { status: "working" } },
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.agents.map((a) => a.agent)).toEqual(["sprout"]);
  });

  it("a document with no agents at all parses as a live, empty sweep", () => {
    const res = parseActivityDocument(JSON.stringify({ schema: 1, swept: SWEPT }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.agents).toEqual([]);
    expect(res.doc.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readActivity - the degrade matrix (the paths that actually run today)
// ---------------------------------------------------------------------------

describe("readActivity - missing state file (the sweep has never run)", () => {
  it("is offline/missing, naming the path it looked at", () => {
    const root = seedRoot(); // directory exists, no file in it
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("missing");
    expect(view.detail).toContain(path.join(root, ACTIVITY_FILENAME));
    expect(view.detail).toContain("has not run");
    expect(view.sweptAt).toBeNull();
    // Nothing readable on disk means nothing to show: the panel gets a note
    // and no cards, never an invented row.
    expect(view.agents).toEqual([]);
  });

  it("is offline/missing when the ROOT itself does not exist either", () => {
    const root = path.join(sandbox(), "never-created");
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("missing");
  });

  it("is offline/unconfigured when no root is set at all", () => {
    const view = readActivity({}, NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("unconfigured");
    expect(view.detail).toContain("ACTIVITY_ROOT");
  });
});

describe("readActivity - unreadable and corrupt files", () => {
  it("is offline/unreadable when the path is a directory (EISDIR), carrying the errno", () => {
    const root = sandbox();
    fs.mkdirSync(path.join(root, ACTIVITY_FILENAME));
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("unreadable");
    // The OBSERVATION, not only the verdict: the next diagnosis starts here.
    expect(view.detail).toMatch(/EISDIR|EACCES/);
  });

  it("is offline/corrupt on garbage, and never throws", () => {
    const root = seedRoot("{not json at all");
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("corrupt");
    expect(view.detail).toContain(ACTIVITY_FILENAME);
  });

  it("is offline/corrupt on an empty file (a sweep that died mid-write)", () => {
    const root = seedRoot("");
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("corrupt");
  });

  it("is offline/unsupported-schema on a future file version", () => {
    const root = seedRoot(JSON.stringify({ ...liveDocument(), schema: 99 }));
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("unsupported-schema");
  });

  it("is offline/corrupt when `swept` is present but unparseable as a date", () => {
    const root = seedRoot(JSON.stringify({ ...liveDocument(), swept: "yesterday-ish" }));
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("corrupt");
    expect(view.detail).toContain("yesterday-ish");
  });

  it("NEVER throws, whatever is in the file", () => {
    const hostile = [
      "",
      "   ",
      "{",
      "[]",
      "null",
      '{"schema":1}',
      '{"schema":1,"swept":null,"agents":null}',
      '{"schema":"1","swept":"' + SWEPT + '"}',
      '{"schema":1,"swept":"' + SWEPT + '","agents":[1,2,3]}',
      " binary",
      JSON.stringify({ schema: 1, swept: SWEPT, agents: { a: { recent: "nope", worktree: 5 } } }),
    ];
    for (const text of hostile) {
      const root = seedRoot(text);
      expect(() => readActivity(env(root), NOW), JSON.stringify(text)).not.toThrow();
    }
  });
});

describe("readActivity - staleness (the honest offline-since state)", () => {
  it("a fresh sweep is live, with the agents and the swept instant", () => {
    const root = seedRoot(JSON.stringify(liveDocument()));
    const view = readActivity(env(root), NOW);
    expect(view.state).toBe("live");
    if (view.state !== "live") return;
    expect(view.sweptAt).toBe(SWEPT);
    expect(view.agents).toHaveLength(4);
    expect(view.agents.map((a) => a.status)).toEqual([
      "done-for-now",
      "needs-you",
      "working",
      "stuck",
    ]);
  });

  it("an old sweep is offline/stale, carrying the last-seen time AND the last-known agents", () => {
    const root = seedRoot(JSON.stringify(liveDocument()));
    // Three hours after the sweep.
    const view = readActivity(env(root), new Date("2026-07-30T13:14:30Z"));
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("stale");
    // The banner needs the ACTUAL last-seen instant ("offline since HH:MM"),
    // not a generic error, so this is the load-bearing assertion.
    expect(view.sweptAt).toBe(SWEPT);
    expect(view.detail).toContain("180 minutes ago");
    // The rows travel with
    // the stale verdict so the panel can dim them under the banner rather than
    // show nothing. The seam hands over everything it legitimately knows; the
    // "not a claim about now" half is enforced where they render.
    expect(view.agents).toHaveLength(4);
    expect(view.agents.map((a) => a.agent)).toEqual(["summit", "sprout", "quill", "fern"]);
    // Whole rows, not a summary: the dimmed card shows evidence and worktree.
    expect(view.agents[0]?.evidence).toContain("no open cards");
    expect(view.agents[0]?.worktree?.branch).toBe("summit/task-599-video-poster-backfill");
  });

  it("an offline state with nothing parseable carries NO agents (never an invented row)", () => {
    // The other four reasons, each proving the same thing: a document we could
    // not read or could not trust yields a note and no cards. corrupt and
    // unsupported-schema are the pointed ones - bytes exist there, and this
    // says we still refuse to render rows out of them.
    const cases: Array<[string, string]> = [
      ["corrupt", "{not json at all"],
      ["unsupported-schema", JSON.stringify({ ...liveDocument(), schema: 99 })],
    ];
    for (const [reason, text] of cases) {
      const view = readActivity(env(seedRoot(text)), NOW);
      expect(view.state, reason).toBe("offline");
      if (view.state !== "offline") continue;
      expect(view.reason).toBe(reason);
      expect(view.agents, reason).toEqual([]);
    }
    // And the unconfigured instance, which reads nothing at all.
    const unconfigured = readActivity({}, NOW);
    expect(unconfigured.state).toBe("offline");
    if (unconfigured.state !== "offline") return;
    expect(unconfigured.agents).toEqual([]);
  });

  it("an unreadable file (exists, but the fs read itself fails) also carries NO agents", () => {
    // A distinct branch from "missing" (ENOENT): the file is there, but
    // readFileSync throws for some other reason (permissions, a transient fs
    // error). Simulated rather than a real chmod, since a test running as
    // root would not actually be denied by a real permission bit.
    const root = seedRoot(JSON.stringify(liveDocument()));
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    try {
      const view = readActivity(env(root), NOW);
      expect(view.state).toBe("offline");
      if (view.state !== "offline") return;
      expect(view.reason).toBe("unreadable");
      expect(view.agents).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the threshold is 10 minutes, and the boundary is exclusive", () => {
    expect(ACTIVITY_STALE_AFTER_MS).toBe(10 * 60 * 1000);
    const root = seedRoot(JSON.stringify(liveDocument()));
    const sweptMs = new Date(SWEPT).getTime();

    // Exactly at the threshold: still live (age > threshold is stale).
    expect(readActivity(env(root), new Date(sweptMs + ACTIVITY_STALE_AFTER_MS)).state).toBe("live");
    // One millisecond past it: stale.
    expect(readActivity(env(root), new Date(sweptMs + ACTIVITY_STALE_AFTER_MS + 1)).state).toBe(
      "offline"
    );
  });

  it("honours an injected threshold (so the constant is not the only knob)", () => {
    const root = seedRoot(JSON.stringify(liveDocument()));
    const view = readActivity(env(root), new Date("2026-07-30T10:15:30Z"), 30_000);
    expect(view.state).toBe("offline");
    if (view.state !== "offline") return;
    expect(view.reason).toBe("stale");
  });

  it("a FUTURE swept timestamp reads live, not stale (clock skew, not death)", () => {
    const root = seedRoot(JSON.stringify(liveDocument()));
    const view = readActivity(env(root), new Date("2026-07-30T09:00:00Z"));
    expect(view.state).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// activityRows - the roster join
// ---------------------------------------------------------------------------

describe("activityRows", () => {
  const swept: AgentActivity[] = [
    {
      agent: "quill",
      status: "working",
      signal: "pane-busy",
      evidence: "busy",
      busy: true,
      idleMinutes: 0,
      worktree: null,
      recent: [],
      subagentCount: null,
      inference: null,
      updated: SWEPT,
    },
  ];

  it("gives a live window the sweep never covered an honest unknown row", () => {
    // Real case, not hypothetical: the sweep skips `nova` by default
    // (ACTIVITY_SKIP_AGENTS), so this state exists on the box today.
    const rows = activityRows(swept, ["quill", "nova"]);
    expect(rows.map((r) => r.agent)).toEqual(["quill", "nova"]);
    const nova = rows[1]!;
    expect(nova.status).toBe("unknown");
    expect(nova.signal).toBe(NOT_SWEPT_SIGNAL);
    expect(nova.evidence).toContain("no record in the last sweep");
    expect(nova.worktree).toBeNull();
    expect(nova.recent).toEqual([]);
  });

  it("keeps the file's order first, appending unswept windows after", () => {
    const rows = activityRows(swept, ["zeta", "quill", "alpha"]);
    expect(rows.map((r) => r.agent)).toEqual(["quill", "zeta", "alpha"]);
  });

  it("is a no-op when every window is covered, and when there are no windows", () => {
    expect(activityRows(swept, ["quill"])).toEqual(swept);
    expect(activityRows(swept, [])).toEqual(swept);
  });

  it("a duplicated window name produces one row, not two", () => {
    const rows = activityRows(swept, ["nova", "nova"]);
    expect(rows.filter((r) => r.agent === "nova")).toHaveLength(1);
  });

  it("a swept agent with no live window is still shown (tmux unreachable)", () => {
    const rows = activityRows(swept, []);
    expect(rows.map((r) => r.agent)).toEqual(["quill"]);
  });
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe("display helpers", () => {
  it("unknown reads as 'no observation', never as a verdict", () => {
    expect(statusLabel("unknown")).toBe("no observation");
    expect(statusLabel("done-for-now")).toBe("idle");
    expect(statusLabel("needs-you")).toBe("needs you");
    expect(statusLabel("waiting-on-machine")).toBe("waiting on machine");
  });

  it("confidence phrasing states none and pinned in their own words", () => {
    expect(confidenceLabel("high")).toBe("high confidence");
    expect(confidenceLabel("low")).toBe("low confidence");
    expect(confidenceLabel("none")).toBe("no match");
    expect(confidenceLabel("pinned")).toBe("pinned");
  });

  it("worktreeName is the last path segment", () => {
    expect(worktreeName("/home/you/git-repos/inkie-summit3")).toBe("inkie-summit3");
    expect(worktreeName("/trailing/slash/")).toBe("slash");
    expect(worktreeName("bare")).toBe("bare");
  });

  it("countStatuses reports taxonomy order and omits zeroes", () => {
    const res = parseActivityDocument(JSON.stringify(liveDocument()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(countStatuses(res.doc.agents)).toEqual([
      { status: "working", count: 1 },
      { status: "stuck", count: 1 },
      { status: "needs-you", count: 1 },
      { status: "done-for-now", count: 1 },
    ]);
    expect(countStatuses([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two producer fields the reader was missing
// ---------------------------------------------------------------------------

/**
 * `subagentCount` and `inference` were written by the producer before this
 * reader had anywhere to put them, so a record carrying both parsed cleanly and
 * dropped them on the floor. These cases pin the shapes rather than the
 * rendering (activity-panel.test.tsx owns that half), and they lean on the
 * degrade paths: both fields cross a JSON boundary from a program on its own
 * release cycle, so the question that matters is what a malformed one costs.
 */
describe("subagentCount", () => {
  function parseOne(value: unknown): AgentActivity {
    const doc = liveDocument() as {
      agents: Record<string, Record<string, unknown>>;
    };
    doc.agents["summit"]!["subagentCount"] = value;
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res.doc.agents.find((a) => a.agent === "summit")!;
  }

  it("carries a positive count", () => {
    expect(parseOne(3).subagentCount).toBe(3);
  });

  // THE THREE-VALUED SPLIT, which is the whole point of the field: zero is a
  // positive claim ("the live UI region was read and listed nothing"), null is
  // the absence of one ("there was no region to read"). A producer's
  // waiting-on-machine branch turns on that difference, so a reader that folded
  // them together would be unable to explain its own pills.
  it("keeps 0 distinct from absent", () => {
    expect(parseOne(0).subagentCount).toBe(0);
    const doc = liveDocument() as { agents: Record<string, Record<string, unknown>> };
    delete doc.agents["summit"]!["subagentCount"];
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.agents.find((a) => a.agent === "summit")!.subagentCount).toBeNull();
  });

  // A count that cannot be one is a producer that cannot be believed about this
  // field, and "no observation" is the honest reading of that. Degrading to 0
  // would be worse: 0 is a CLAIM here, and inventing one from garbage is
  // exactly the confident-wrong-answer this panel exists to avoid.
  it("degrades a value that cannot be a count to null, never to 0", () => {
    for (const bad of [-1, 1.5, "2", true, null, {}, Number.NaN]) {
      expect(parseOne(bad).subagentCount, JSON.stringify(bad)).toBeNull();
    }
  });

  it("does not reject the record, or the document, over a bad count", () => {
    const row = parseOne("nonsense");
    expect(row.status).toBe("done-for-now");
    expect(row.evidence).not.toBe("");
  });
});

describe("inference", () => {
  function parseWith(value: unknown): AgentActivity {
    const doc = liveDocument() as {
      agents: Record<string, Record<string, unknown>>;
    };
    doc.agents["summit"]!["inference"] = value;
    const res = parseActivityDocument(JSON.stringify(doc));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res.doc.agents.find((a) => a.agent === "summit")!;
  }

  const full = {
    taskLine: "wiring thread windowing into the message list",
    progressNote: "three of five call sites done",
    current: true,
    staleReason: null,
    paneMoved: false,
    ageSeconds: 240,
    generatedAt: "2026-07-30T10:10:00Z",
    sourceSwept: SWEPT,
    outcome: "ok",
  };

  it("parses a complete record", () => {
    expect(parseWith(full).inference).toEqual(full);
  });

  it("is null when the producer publishes none", () => {
    expect(parseWith(undefined).inference).toBeNull();
    expect(parseWith(null).inference).toBeNull();
    expect(parseWith("prose").inference).toBeNull();
    expect(parseWith([]).inference).toBeNull();
  });

  // The producer RETAINS a stale-but-provably-aged sentence and marks it, so
  // current:false with a taskLine present is the normal marked case rather than
  // a contradiction. Both halves have to survive parsing, or the marker arrives
  // without the thing it marks.
  it("keeps a retained sentence alongside its staleness reason and age", () => {
    const row = parseWith({
      ...full,
      current: false,
      staleReason: "signal-moved",
      paneMoved: true,
      ageSeconds: 5400,
    });
    expect(row.inference?.taskLine).toBe(full.taskLine);
    expect(row.inference?.current).toBe(false);
    expect(row.inference?.staleReason).toBe("signal-moved");
    expect(row.inference?.ageSeconds).toBe(5400);
  });

  // FRESHNESS DEGRADES TOWARDS MARKED, never towards current. An unreadable
  // flag means the reader cannot show the sentence as a claim about now.
  it("treats an unreadable `current` as not current", () => {
    for (const bad of ["true", 1, null, undefined]) {
      expect(parseWith({ ...full, current: bad }).inference?.current, String(bad)).toBe(false);
    }
  });

  it("degrades each field independently rather than dropping the object", () => {
    const row = parseWith({
      taskLine: 42,
      progressNote: null,
      current: true,
      staleReason: { nested: true },
      paneMoved: "yes",
      ageSeconds: "240",
    });
    expect(row.inference).not.toBeNull();
    expect(row.inference?.taskLine).toBeNull();
    expect(row.inference?.staleReason).toBeNull();
    // Only a literal `true` is true; a truthy string is not a boolean.
    expect(row.inference?.paneMoved).toBe(false);
    expect(row.inference?.ageSeconds).toBeNull();
    // And the deterministic half of the record is untouched by any of it.
    expect(row.status).toBe("done-for-now");
  });

  // PROSE ONLY, NO PILL AUTHORITY. The producer builds this object from an
  // allowlist so a model's own status read cannot reach the document; the
  // reader has no field for one either, so even a producer that started
  // emitting one could not get it in front of a consumer through this seam.
  it("has nowhere to put a model's own status read", () => {
    const row = parseWith({ ...full, statusRead: "needs-you", statusWhy: "it asked me" });
    expect(row.status).toBe("done-for-now");
    expect(JSON.stringify(row)).not.toContain("statusRead");
    expect(JSON.stringify(row)).not.toContain("needs-you");
  });
});
