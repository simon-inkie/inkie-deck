/**
 * Stage zero: prove the base is bare, by REQUIRING ABSENCE.
 *
 * Every other stage in this rig is a claim of the form "the product behaves
 * like this on a clean machine". Each of those claims is worth exactly as
 * much as the word "clean", and the baseline run showed how little that word
 * is worth by default: the product's undocumented prerequisites (a live git
 * repository, ripgrep) were invisible for as long as they were on every
 * machine that ran it. So this stage does not check that the base is
 * plausible, it checks that specific things are NOT THERE, and it fails the
 * whole run if any of them is.
 *
 * It also records the facts a container cannot establish about itself: the
 * image digest, that no mount is attached, and that the container's
 * configured environment is PATH and nothing else. A probe inside a container
 * that inherited the developer's home would report a perfectly clean $HOME
 * for whatever home it was given.
 */
import { control, probe } from "../lib/harness.mjs";
import { build, containerFacts, pull, runIn } from "../lib/docker.mjs";
import { RigError } from "../lib/exec.mjs";
import { ALLOWED_HOME_ENTRIES, BASE_IMAGE, MUST_BE_ABSENT } from "../expected.mjs";

const PROBE_SCRIPT = `
for b in ${MUST_BE_ABSENT.join(" ")}; do
  if command -v "$b" >/dev/null 2>&1; then echo "bin=$b:present"; else echo "bin=$b:absent"; fi
done
echo "home=$HOME"
find "$HOME" -mindepth 1 -maxdepth 1 -printf 'homeentry=%f\\n' 2>/dev/null || true
if [ -d "$HOME/agents" ]; then echo "agentsdir=present"; else echo "agentsdir=absent"; fi
env | sed 's/^/env=/'
echo "complete=yes"
`;

/**
 * Run the absence probe against an image and return every violation it found.
 * Shared by the positive attestation and by the negative control, so the
 * control exercises the same code path the real assertion uses. A control
 * that validates a reimplementation of the probe validates nothing.
 *
 * @param {string} ref
 */
export function attest(ref) {
  const result = runIn(ref, PROBE_SCRIPT);
  if (!result.ok || !result.stdout.includes("complete=yes")) {
    throw new RigError(
      `the bareness probe did not complete inside ${ref} (status ${result.status}):\n${result.output.slice(-2000)}`,
    );
  }
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const present = lines
    .filter((line) => line.startsWith("bin=") && line.endsWith(":present"))
    .map((line) => line.slice(4, -":present".length));
  const homeEntries = lines.filter((line) => line.startsWith("homeentry=")).map((line) => line.slice(10));
  const agentsDir = lines.includes("agentsdir=present");
  const containerEnv = lines.filter((line) => line.startsWith("env=")).map((line) => line.slice(4));

  const violations = [];
  for (const binary of present) violations.push(`binary present: ${binary}`);
  for (const entry of homeEntries) {
    if (!ALLOWED_HOME_ENTRIES.includes(entry)) violations.push(`home entry: ${entry}`);
  }
  if (agentsDir) violations.push("agent home directory present: ~/agents");

  return { ref, present, homeEntries, agentsDir, containerEnv, violations, raw: result.stdout };
}

export default {
  id: "base-attestation",
  title: "the base image is provably bare",
  async run(ctx) {
    pull(BASE_IMAGE);
    const facts = containerFacts(BASE_IMAGE);
    const digest = facts.repoDigests[0] ?? facts.id;
    ctx.base = { ref: BASE_IMAGE, digest, id: facts.id };

    const attestation = attest(BASE_IMAGE);

    // The configured environment must be PATH alone. Anything else is
    // something the image or the client decided to hand every container, and
    // an inherited value is exactly how a "clean machine" stops being one.
    const nonPathEnv = facts.env.filter((entry) => !entry.startsWith("PATH="));

    const probes = [
      probe({
        id: "absent-binaries",
        title: `none of ${MUST_BE_ABSENT.join(", ")} is installed`,
        ok: attestation.present.length === 0,
        detail: attestation.present.length === 0 ? "all absent" : `present: ${attestation.present.join(", ")}`,
      }),
      probe({
        id: "empty-home",
        title: "$HOME carries no state beyond the image's own skeleton files",
        ok: attestation.homeEntries.every((entry) => ALLOWED_HOME_ENTRIES.includes(entry)),
        detail: `entries: ${attestation.homeEntries.join(", ") || "(none)"}`,
      }),
      probe({
        id: "no-agent-home",
        title: "~/agents does not exist",
        ok: !attestation.agentsDir,
      }),
      probe({
        id: "no-mounts",
        title: "a container from this image starts with zero mounts",
        ok: facts.mounts.length === 0,
        detail: `mounts: ${JSON.stringify(facts.mounts)}`,
      }),
      probe({
        id: "env-is-path-only",
        title: "the container inherits no environment beyond PATH",
        ok: nonPathEnv.length === 0,
        detail: nonPathEnv.length === 0 ? facts.env.join(" ") : `extra: ${nonPathEnv.join(" ")}`,
      }),
      probe({
        id: "digest-recorded",
        title: "the image digest is recorded",
        ok: Boolean(digest),
        detail: digest,
      }),
    ];

    // NEGATIVE CONTROL. An absence check is the easiest kind of check to write
    // backwards: invert the sense of one comparison and it passes everything
    // forever, silently, because the environments it is normally shown are
    // the ones it is supposed to pass. So show it a base that is provably NOT
    // bare - git installed, an agent home planted - and require it to name
    // both, by name. Requiring only "it failed" would be satisfied by a probe
    // that crashed.
    build({
      tag: "inkie-deck-rig/contaminated-base:v1",
      contextDir: ctx.contextDir,
      dockerfile: [
        `FROM ${BASE_IMAGE}`,
        "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \\",
        " && rm -rf /var/lib/apt/lists/*",
        "RUN mkdir -p /root/agents/alice && printf 'stub\\n' > /root/agents/alice/SOUL.md",
        "",
      ].join("\n"),
    });
    const contaminated = attest("inkie-deck-rig/contaminated-base:v1");
    const namedGit = contaminated.violations.includes("binary present: git");
    const namedAgents = contaminated.violations.some((v) => v.includes("~/agents"));

    const controls = [
      control({
        id: "contaminated-base-rejected",
        title: "the same attestation, run against a deliberately contaminated base",
        expectation: "violations naming the git binary AND the planted ~/agents directory",
        satisfied: namedGit && namedAgents,
        observed: contaminated.violations.join("; ") || "(no violations found: the attestation is blind)",
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        image: { ref: BASE_IMAGE, digest, id: facts.id, mounts: facts.mounts, env: facts.env },
        containerEnv: attestation.containerEnv,
        homeEntries: attestation.homeEntries,
      },
    };
  },
};
