/**
 * Stage two: install the toolchain on the bare base, and prove what got
 * installed.
 *
 * The tools are asserted individually and by version rather than by "the
 * install command exited 0". An apt install that silently gives you Node 18
 * also exits 0, and that is not a hypothetical: it is what the obvious
 * `apt-get install nodejs` does on this base, four major versions under the
 * floor.
 */
import { control, probe } from "../lib/harness.mjs";
import { build, runIn } from "../lib/docker.mjs";
import { RigError } from "../lib/exec.mjs";
import { toolchainDockerfile } from "../lib/images.mjs";
import { versionAtLeast } from "../lib/version.mjs";
import { NODE_FLOOR, REQUIRED_TOOLS } from "../expected.mjs";

/**
 * A deliberately absent binary, probed alongside the real ones.
 *
 * The version probe shells out, and the baseline run found a check in this
 * repository that scored a missing binary as success because it coalesced a
 * null exit status to zero. Asking the same parser about a binary that
 * certainly does not exist, every run, is how this rig stays unable to
 * acquire that bug quietly.
 */
const ABSENT_SENTINEL = "rig-absent-sentinel";

const VERSION_COMMANDS = {
  node: "node --version",
  corepack: "corepack --version",
  pnpm: "pnpm --version",
  git: "git --version",
  rg: "rg --version | head -1",
  curl: "curl --version | head -1",
  tmux: "tmux -V",
  [ABSENT_SENTINEL]: `${ABSENT_SENTINEL} --version`,
};

/**
 * @param {string} ref
 * @returns {Record<string, { present: boolean, version: string|null, raw: string }>}
 */
export function inventory(ref) {
  const script = Object.entries(VERSION_COMMANDS)
    .map(
      ([tool, command]) => `
if command -v ${tool.split(" ")[0]} >/dev/null 2>&1; then
  echo "tool=${tool}:present:$(${command} 2>&1 | tr '\\n' ' ')"
else
  echo "tool=${tool}:absent:"
fi`,
    )
    .join("\n");
  const result = runIn(ref, `${script}\necho "complete=yes"`);
  if (!result.stdout.includes("complete=yes")) {
    throw new RigError(`the toolchain inventory did not complete in ${ref}:\n${result.output.slice(-2000)}`);
  }
  /** @type {Record<string, { present: boolean, version: string|null, raw: string }>} */
  const found = {};
  for (const line of result.stdout.split("\n")) {
    const match = /^tool=([^:]+):(present|absent):(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[3].trim();
    const version = /(\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? null;
    found[match[1]] = { present: match[2] === "present", version, raw };
  }
  return found;
}

export default {
  id: "toolchain",
  title: "Node at or above the engines floor, plus the tools the product needs",
  async run(ctx) {
    const tag = `inkie-deck-rig/toolchain:${ctx.source.sha.slice(0, 12)}`;
    build({
      tag,
      contextDir: ctx.contextDir,
      dockerfile: toolchainDockerfile({ nodeMajor: 22, pnpmSpec: ctx.packageManager }),
    });
    ctx.toolchainImage = tag;

    const tools = inventory(tag);
    const pnpmPinned = ctx.packageManager.split("@")[1];

    const probes = REQUIRED_TOOLS.map((tool) =>
      probe({
        id: `tool-${tool}`,
        title: `${tool} is installed`,
        ok: tools[tool]?.present === true,
        detail: tools[tool]?.raw || "absent",
      }),
    );
    probes.push(
      probe({
        id: "node-floor",
        title: `node is at or above the ${NODE_FLOOR} engines floor`,
        ok: Boolean(tools.node?.version) && versionAtLeast(tools.node.version, NODE_FLOOR),
        detail: tools.node?.raw ?? "absent",
      }),
      probe({
        id: "pnpm-pinned",
        title: `pnpm matches the packageManager pin (${ctx.packageManager})`,
        ok: tools.pnpm?.version === pnpmPinned,
        detail: `${tools.pnpm?.raw ?? "absent"} against ${pnpmPinned}`,
      }),
    );

    const controls = [
      control({
        id: "absent-binary-not-scored-as-present",
        title: `the same inventory parser, asked about ${ABSENT_SENTINEL}`,
        expectation: "reported absent, with no version, rather than silently as a success",
        satisfied: tools[ABSENT_SENTINEL]?.present === false && tools[ABSENT_SENTINEL]?.version === null,
        observed: JSON.stringify(tools[ABSENT_SENTINEL] ?? null),
      }),
      control({
        id: "floor-comparator-rejects-node-20",
        title: "the version comparator, shown the versions it must separate",
        // A string or float compare gets both of these wrong, and would pass a
        // Node 20 environment as meeting a 22.18 floor. The measured Node 20
        // run is a separate stage; this control is about the arithmetic.
        expectation: "20.19.5 is below the floor, 22.18.0 meets it, 22.9.0 is below it",
        satisfied:
          versionAtLeast("20.19.5", NODE_FLOOR) === false &&
          versionAtLeast("22.18.0", NODE_FLOOR) === true &&
          versionAtLeast("22.9.0", NODE_FLOOR) === false,
        observed: `20.19.5 -> ${versionAtLeast("20.19.5", NODE_FLOOR)}, 22.18.0 -> ${versionAtLeast("22.18.0", NODE_FLOOR)}, 22.9.0 -> ${versionAtLeast("22.9.0", NODE_FLOOR)}`,
      }),
    ];

    return { probes, controls, evidence: { image: tag, tools } };
  },
};
