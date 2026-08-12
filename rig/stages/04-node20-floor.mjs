/**
 * Stage four: Node 20, which is below the engines floor, run as a measured
 * negative control rather than an assumption.
 *
 * The question is not whether Node 20 works. It is whether a person on Node
 * 20 finds out WHY, from the tool, on the first command they type. So this
 * stage requires the documented list to go red and then records the failure
 * verbatim, and it treats an obscure failure as a finding to be written down
 * rather than as a pass. The baseline run's most expensive discoveries were
 * all of that shape: a real error, correctly raised, with no textual link to
 * its cause.
 */
import { control, probe } from "../lib/harness.mjs";
import { build } from "../lib/docker.mjs";
import { runIn } from "../lib/docker.mjs";
import { tail } from "../lib/exec.mjs";
import { toolchainDockerfile } from "../lib/images.mjs";
import { inventory } from "./02-toolchain.mjs";
import { DOCUMENTED_CHECKS } from "../expected.mjs";
import { parseExitCodes } from "./03-documented-checks.mjs";
import { versionAtLeast } from "../lib/version.mjs";
import { NODE_FLOOR } from "../expected.mjs";

/** Words that would let a reader connect the failure to the Node version. */
const LOUDNESS = /engine|node.*(20|22)|22\.18|unsupported/i;

export default {
  id: "node20-floor",
  title: "Node 20 is refused, and the way it is refused is recorded",
  async run(ctx) {
    const tag = `inkie-deck-rig/node20:${ctx.source.sha.slice(0, 12)}`;
    // Built from the same function as the toolchain image, so the Node major
    // is the only variable. A control that differs in two things cannot
    // attribute the failure to either.
    let buildLog = "";
    let built = true;
    try {
      buildLog = build({
        tag,
        contextDir: ctx.contextDir,
        dockerfile: toolchainDockerfile({ nodeMajor: 20, pnpmSpec: ctx.packageManager }),
      }).log;
    } catch (error) {
      // A failure to build IS the answer to this stage's question, when it is
      // corepack or pnpm refusing the Node version. Record it and carry on
      // rather than treating it as a rig failure.
      built = false;
      buildLog = String(error?.message ?? error);
    }

    const tools = built ? inventory(tag) : {};
    const nodeVersion = tools.node?.version ?? null;

    let checks = null;
    if (built) {
      const result = runIn(
        tag,
        `cd /src\n${DOCUMENTED_CHECKS.map(({ id, command }) => `echo "###BEGIN ${id}"\n${command}\necho "###EXIT ${id} $?"`).join("\n")}`,
      );
      checks = { codes: parseExitCodes(result.output), output: result.output };
    }

    const failedSomewhere = !built || Object.values(checks?.codes ?? {}).some((code) => code !== 0);
    const evidenceText = built ? checks.output : buildLog;
    const loud = LOUDNESS.test(evidenceText);
    const firstFailure = built
      ? DOCUMENTED_CHECKS.find(({ id }) => checks.codes[id] !== 0)?.id ?? "(none: everything passed)"
      : "image build";

    const probes = [
      probe({
        id: "node-20-refused",
        title: "the documented check list does not go green on Node 20",
        ok: failedSomewhere,
        detail: `first failing step: ${firstFailure}`,
      }),
      probe({
        id: "failure-is-legible",
        title: "the failure text lets a reader connect it to the Node version",
        // A finding, not a failure: the plan's instruction is to record HOW
        // Node 20 fails, and an illegible failure is a defect in the product's
        // ergonomics rather than in the environment under test.
        severity: "finding",
        ok: loud,
        detail: loud ? "the output names the engine requirement" : "nothing in the output names Node or the engines floor",
      }),
    ];

    const controls = [
      control({
        id: "control-environment-is-valid",
        title: "the Node 20 image really is Node 20, with every other tool present",
        // Without this, a red result above could be a missing ripgrep or a
        // broken image wearing Node 20's clothes.
        expectation: built
          ? "node 20.x, below the floor, with git, ripgrep and tmux all present"
          : "the image build itself failed, which is the Node 20 refusal",
        satisfied: built
          ? Boolean(nodeVersion) &&
            nodeVersion.startsWith("20.") &&
            versionAtLeast(nodeVersion, NODE_FLOOR) === false &&
            ["git", "rg", "tmux"].every((tool) => tools[tool]?.present)
          : /node|engine|pnpm|corepack/i.test(buildLog),
        observed: built
          ? `node ${nodeVersion}; git ${tools.git?.present}; rg ${tools.rg?.present}; tmux ${tools.tmux?.present}`
          : tail(buildLog, 15),
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        image: built ? tag : null,
        built,
        nodeVersion,
        exitCodes: checks?.codes ?? null,
        verbatim: tail(evidenceText, 40),
      },
    };
  },
};
