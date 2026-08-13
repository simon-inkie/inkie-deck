/**
 * Stage four: Node 20 is refused at install, and the refusal is recorded
 * verbatim.
 *
 * This stage used to measure the opposite thing. Node 20 reached end of life
 * on 2026-04-30, the manifests declared a floor above it, and pnpm treats
 * `engines` as advisory: measured here, a clean Node 20 machine installed,
 * typechecked, ran all 1770 tests and passed every gate, exit 0 throughout.
 * The floor was a comment. `engine-strict=true` in `.npmrc` made it a
 * refusal, and this stage now asserts the refusal instead of reporting its
 * absence.
 *
 * The refusal has to land at INSTALL, the first command in the documented
 * list. A floor that only bites at test time has already let the reader spend
 * ten minutes on an unsupported runtime, and a floor that bites somewhere
 * unpredictable is indistinguishable from the product simply being broken.
 */
import { control, probe } from "../lib/harness.mjs";
import { build, runIn } from "../lib/docker.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { toolchainDockerfile } from "../lib/images.mjs";
import { inventory } from "./02-toolchain.mjs";
import { DOCUMENTED_CHECKS, NODE_ENGINES } from "../expected.mjs";
import { parseExitCodes } from "./03-documented-checks.mjs";
import { satisfiesRange } from "../lib/version.mjs";

/**
 * The refusal, as pnpm raises it.
 *
 * Matched on the error CODE rather than on prose, because the prose is
 * pnpm's to reword between releases while the code is its contract. Whether
 * the accompanying wording is any use to a human is asserted separately: a
 * machine-readable code nobody can read is half the ergonomics this stage is
 * about.
 */
const REFUSAL_CODE = /ERR_PNPM_UNSUPPORTED_ENGINE/;

/**
 * Wording that lets a reader connect the failure to the Node version.
 *
 * Deliberately narrow. An earlier version of this pattern also matched a bare
 * "node" next to a number, which the suite's ordinary output satisfies on
 * every run, so it reported a legible failure on a run where nothing had
 * failed at all.
 */
const LOUDNESS = /unsupported engine|ERR_PNPM_UNSUPPORTED_ENGINE|engines? (field|requirement)|expected version.*node|requires node/i;

/**
 * The refusal message itself, cut out of the surrounding log.
 *
 * Recorded separately from the tail of the output because the question this
 * stage exists to answer is what the person on Node 20 actually reads, and a
 * 40-line tail that happens to contain it is not the same artefact as the
 * message.
 *
 * @param {string} text @returns {string|null}
 */
export function extractRefusal(text) {
  const lines = stripAnsi(text).split("\n");
  const start = lines.findIndex((line) => REFUSAL_CODE.test(line));
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start)) {
    // The refusal ends at the marker the runner prints after the command.
    // Its own blank lines are part of it, so it cannot be terminated on the
    // first empty line: doing that captures one sentence and drops the two
    // that say which version was expected and which was found.
    if (/^###(EXIT|BEGIN)\b/.test(line)) break;
    block.push(line);
  }
  return block.join("\n").trimEnd();
}

export default {
  id: "node20-floor",
  title: "Node 20 is refused at install, and the refusal is recorded",
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
      // A failure to build IS a refusal, when it is corepack or pnpm refusing
      // the Node version. Record it and carry on rather than treating it as a
      // rig failure.
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

    const evidenceText = built ? checks.output : buildLog;
    const clean = stripAnsi(evidenceText);
    // `!== 0 && !== null` rather than a truthiness test: a command that never
    // produced an exit marker parses as null, and null is not a refusal, it
    // is an unknown. Scoring it as a refusal is the `?? 0` bug wearing the
    // other hat.
    const installRefused = built ? checks.codes.install !== 0 && checks.codes.install !== null : true;
    const refusal = extractRefusal(evidenceText);
    const wentGreenAnyway = built && Object.values(checks.codes).every((code) => code === 0);

    const probes = [
      probe({
        id: "install-refuses-node-20",
        title: "`pnpm install` refuses to run on Node 20",
        ok: installRefused,
        detail: !built
          ? "the image build itself failed, which is a refusal even earlier than install"
          : installRefused
            ? `install exited ${checks.codes.install}`
            : `NOTHING REFUSED IT: install exited ${JSON.stringify(checks.codes.install)} on node ${nodeVersion}` +
              (wentGreenAnyway ? ", and every later documented check exited 0 too" : "") +
              `. The ${NODE_ENGINES} range is a claim in package.json that no command enforces.`,
      }),
      probe({
        id: "refusal-names-the-engine",
        title: "the refusal tells the reader it is about the Node version",
        // No longer a "finding". While nothing enforced the floor, HOW Node 20
        // failed was whatever the ecosystem happened to do that day and not
        // the product's to promise. The refusal is now ours, raised by our own
        // setting, so its legibility is ours to assert.
        ok: installRefused && LOUDNESS.test(clean),
        detail: !installRefused
          ? "nothing was refused, so there is no refusal to read"
          : refusal
            ? `refusal captured, ${refusal.split("\n").length} lines`
            : "OBSCURE: it failed, but nothing in the output names Node or the engines range",
      }),
      probe({
        id: "refusal-quotes-the-range",
        title: "the refusal quotes the range the reader has to satisfy",
        // "Unsupported engine" without saying WHAT is supported leaves the
        // reader to go and find package.json for themselves. The baseline
        // run's most expensive discoveries were all this shape: a real error,
        // correctly raised, with no textual link to its cause.
        ok: clean.includes(NODE_ENGINES),
        detail: clean.includes(NODE_ENGINES)
          ? `the output contains "${NODE_ENGINES}"`
          : `the output never quotes "${NODE_ENGINES}", so the reader is not told what would work`,
      }),
    ];

    // The same install, on the supported Node the rest of the rig runs on.
    // Without it, every probe above is equally satisfied by a product whose
    // install is simply broken - and that is not hypothetical here, because
    // engine-strict applies to the whole dependency graph, so a dependency
    // with a narrow or badly written range can refuse a version we intend to
    // support. This control is what makes the stage able to go red for that.
    const supported = runIn(ctx.toolchainImage, 'cd /src\npnpm install\necho "###EXIT install $?"');
    const supportedCodes = parseExitCodes(supported.output);
    const supportedNode = inventory(ctx.toolchainImage).node?.version ?? null;
    const supportedRefused = REFUSAL_CODE.test(stripAnsi(supported.output));

    const controls = [
      control({
        id: "control-environment-is-valid",
        title: "the Node 20 image really is Node 20, with every other tool present",
        // Without this, a red result above could be a missing ripgrep or a
        // broken image wearing Node 20's clothes.
        expectation: built
          ? "node 20.x, outside the engines range, with git, ripgrep and tmux all present"
          : "the image build itself failed, which is the Node 20 refusal",
        satisfied: built
          ? Boolean(nodeVersion) &&
            nodeVersion.startsWith("20.") &&
            satisfiesRange(nodeVersion, NODE_ENGINES) === false &&
            ["git", "rg", "tmux"].every((tool) => tools[tool]?.present)
          : /node|engine|pnpm|corepack/i.test(buildLog),
        observed: built
          ? `node ${nodeVersion}; git ${tools.git?.present}; rg ${tools.rg?.present}; tmux ${tools.tmux?.present}`
          : tail(buildLog, 15),
      }),
      control({
        id: "control-supported-node-is-not-refused",
        title: "the same install, on a Node the range does permit",
        expectation: `pnpm install exits 0 on node ${supportedNode ?? "22.x"}, with no unsupported-engine refusal`,
        satisfied: supportedCodes.install === 0 && !supportedRefused,
        observed:
          `install exited ${JSON.stringify(supportedCodes.install)} on node ${supportedNode ?? "(unrecorded)"}; ` +
          `refusal present: ${supportedRefused}`,
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
        // Whole, not tailed: "what does a Node 20 user see" is the question
        // this stage answers, and a paraphrase does not answer it.
        refusal,
        supported: { node: supportedNode, image: ctx.toolchainImage, exit: supportedCodes.install },
        tail: tail(evidenceText, 40),
      },
    };
  },
};
