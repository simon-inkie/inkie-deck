/**
 * Stage one: get the source in, from a committed tree, and prove nothing else
 * came with it.
 *
 * `git archive` rather than a bind mount, because the mount is how the
 * developer's `node_modules/`, `.runtime/` and `build/` reach a container
 * that is supposed to be measuring a clean install. The commit is recorded so
 * a report can be tied to a tree; a dirty working copy is refused outright
 * unless the operator overrides it, because "the rig was green" against an
 * uncommitted tree is a claim nobody can reproduce.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { control, probe } from "../lib/harness.mjs";
import { must, RigError } from "../lib/exec.mjs";
import {
  archiveHead,
  contaminatedEntries,
  dirtyTreeDecision,
  headSha,
  porcelainStatus,
} from "../lib/source.mjs";

export default {
  id: "source-entry",
  title: "source enters from a committed tree, and carries no developer state",
  async run(ctx) {
    const porcelain = porcelainStatus(ctx.repoRoot);
    const decision = dirtyTreeDecision({ porcelain, allowDirty: ctx.allowDirty });
    if (decision.refuse) {
      throw new RigError(
        `the working tree is dirty, so an archive of HEAD is not what you are looking at.\n` +
          `Commit, stash, or re-run with --allow-dirty (the report will say so, loudly).\n` +
          decision.entries.slice(0, 20).join("\n"),
      );
    }

    const sha = headSha(ctx.repoRoot);
    const { tarPath, entries } = archiveHead({ repoRoot: ctx.repoRoot, contextDir: ctx.contextDir, sha });
    const contaminated = contaminatedEntries(entries);
    ctx.source = {
      sha,
      dirty: decision.dirty,
      allowDirty: ctx.allowDirty,
      archiveEntries: entries.length,
      tarPath,
      uncommittedPaths: decision.dirty ? decision.entries : [],
    };

    const probes = [
      probe({
        id: "commit-recorded",
        title: "the archived commit is recorded",
        ok: /^[0-9a-f]{40}$/.test(sha),
        detail: sha,
      }),
      probe({
        id: "clean-tree",
        title: "the archive is of a clean working tree",
        ok: !decision.dirty,
        // Not a hard failure when the operator asked for it: the override
        // exists so a rig change can be tested before it is committed. The
        // report shouts about it instead.
        severity: ctx.allowDirty ? "finding" : "fail",
        detail: decision.dirty
          ? `OVERRIDDEN with --allow-dirty. ${decision.entries.length} uncommitted path(s); the archived tree is NOT the working copy.`
          : "clean",
      }),
      probe({
        id: "no-developer-state",
        title: "the archive carries no node_modules, .runtime, build or .env",
        ok: contaminated.length === 0,
        detail: contaminated.length === 0 ? `${entries.length} entries` : contaminated.slice(0, 10).join(", "),
      }),
      probe({
        id: "archive-non-trivial",
        title: "the archive actually contains the workspace",
        ok:
          entries.some((entry) => entry === "package.json") &&
          entries.some((entry) => entry.startsWith("packages/deck/")) &&
          entries.some((entry) => entry.startsWith("packages/base/")),
        detail: `${entries.length} entries`,
      }),
    ];

    // NEGATIVE CONTROL 1. The contamination predicate is the only thing
    // standing between this rig and a bind mount's worth of developer state,
    // and it is a filter over a list, which is the kind of code that returns
    // an empty array for the wrong reason and looks like good news. Build a
    // real tar with a planted node_modules file, list it the same way, and
    // require the predicate to name it.
    const planted = plantContaminatedArchive();
    let plantedFindings;
    try {
      const listed = must("tar", ["-tf", planted.tarPath]);
      plantedFindings = contaminatedEntries(listed.stdout.split("\n").filter(Boolean));
    } finally {
      fs.rmSync(planted.dir, { recursive: true, force: true });
    }

    // NEGATIVE CONTROL 2. The dirty-tree refusal never fires on a clean tree,
    // which is the normal case, so on its own it would be untested code
    // guarding the rig's most important claim. Exercise the decision directly.
    const refusal = dirtyTreeDecision({ porcelain: " M packages/deck/app/root.tsx\n?? scratch.txt\n", allowDirty: false });
    const override = dirtyTreeDecision({ porcelain: " M packages/deck/app/root.tsx\n", allowDirty: true });

    const controls = [
      control({
        id: "planted-contamination-detected",
        title: "the contamination predicate, shown a tar containing node_modules",
        expectation: "the planted node_modules path is reported",
        satisfied: plantedFindings.some((entry) => entry.includes("node_modules")),
        observed: plantedFindings.join(", ") || "(nothing reported: the predicate is blind)",
      }),
      control({
        id: "dirty-tree-refused",
        title: "the dirty-tree decision, shown a dirty status",
        expectation: "refuse without --allow-dirty, and permit-but-flag with it",
        satisfied: refusal.refuse === true && override.refuse === false && override.dirty === true,
        observed: `without override: refuse=${refusal.refuse}; with override: refuse=${override.refuse}, dirty=${override.dirty}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        sha,
        archiveEntries: entries.length,
        dirty: decision.dirty,
        allowDirty: ctx.allowDirty,
        fixtureRuntimeEntries: entries.filter((entry) => entry.includes("/.runtime/")).length,
      },
    };
  },
};

/** A tar that a bind mount would produce: source plus developer state. */
function plantContaminatedArchive() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rig-planted-"));
  fs.mkdirSync(path.join(dir, "tree", "node_modules", "left-behind"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tree", "package.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "tree", "node_modules", "left-behind", "index.js"), "// dev state\n");
  const tarPath = path.join(dir, "planted.tar");
  must("tar", ["-cf", tarPath, "-C", path.join(dir, "tree"), "."]);
  return { dir, tarPath };
}
